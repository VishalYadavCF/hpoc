import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { ENV } from '../../platform/config/config.module.js';
import type { ApiEnv } from '../../platform/config/env.schema.js';
import { EventListener } from '../../platform/persistence/event-listener.js';
import { EventLog } from '../../domain/event-log/event-log.service.js';
import { Metrics } from '../../platform/observability/metrics.js';

const TERMINAL_EVENT = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.dead_lettered']);
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled', 'dead_letter']);

/**
 * A response that can only be ended once.
 *
 * Every write goes through `ended`, because the failure it prevents is not theoretical:
 * ending on a terminal event and then flushing a buffered notification throws
 * ERR_STREAM_WRITE_AFTER_END, which the client sees as a connection reset rather than a
 * clean end of stream.
 */
class SseStream {
  ended = false;
  private readonly heartbeat: NodeJS.Timeout;
  private onCloseFn?: () => void;

  constructor(
    private readonly res: Response,
    heartbeatMs: number,
  ) {
    // Load balancers drop idle connections; a comment line is the cheapest keep-alive.
    this.heartbeat = setInterval(() => this.comment(': ping\n'), heartbeatMs);
    res.on('close', () => this.close());
  }

  onClose(fn: () => void): void {
    this.onCloseFn = fn;
  }

  comment(raw: string): void {
    if (this.ended) return;
    this.res.write(`${raw}\n`);
  }

  /** Returns false when the socket asked us to back off. */
  event(id: number, type: string, data: unknown): boolean {
    if (this.ended) return false;
    return this.res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    this.onCloseFn?.();
    this.res.end();
  }
}

@Injectable()
export class RunStreamService {
  private readonly log = new Logger(RunStreamService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly listener: EventListener,
    private readonly events: EventLog,
    private readonly metrics: Metrics,
  ) {
    metrics.describe('sse_connections', 'Open SSE streams');
    metrics.describe('sse_dropped_slow_client', 'Streams closed because the client could not keep up');
  }

  /**
   * Replay-then-tail, in the one order that has no gap.
   *
   * The naive sequence -- read history, then subscribe -- drops any event written between
   * the read and the subscribe. So: subscribe FIRST into a buffer, then replay from the
   * cursor, then flush anything buffered that the replay did not already cover, then tail.
   */
  async attach(runId: string, res: Response, lastEventId: number): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Without this nginx buffers the whole stream and the client sees nothing until the
      // run ends -- the classic "SSE works locally, not in staging" failure (§12.1).
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const stream = new SseStream(res, this.env.SSE_HEARTBEAT_MS);
    let buffering = true;
    let pending = false;
    let cursor = lastEventId;

    const unsubscribe = await this.listener.subscribe(runId, () => {
      if (buffering) pending = true;
      else void this.drain(runId, stream, cursor).then((c) => (cursor = c));
    });

    this.metrics.increment('sse_connections');
    stream.onClose(() => unsubscribe());

    // Sent before any event, so a client reconnecting past the retention window learns it
    // must re-read state rather than assume continuity.
    stream.comment(
      `event: stream.connected\ndata: ${JSON.stringify({
        runId,
        fromSeq: lastEventId,
        replayRetentionHours: this.env.SSE_REPLAY_RETENTION_HOURS,
      })}\n`,
    );

    try {
      cursor = await this.drain(runId, stream, cursor);
      buffering = false;
      if (pending) cursor = await this.drain(runId, stream, cursor);
    } catch (e) {
      this.log.warn(`stream ${runId} failed during replay: ${(e as Error).message}`);
      stream.close();
      return;
    }

    if (!stream.ended) {
      const run = await this.db
        .selectFrom('runs')
        .select('status')
        .where('id', '=', runId)
        .executeTakeFirst();
      // A run that reached a terminal state before we attached has nothing left to tail.
      if (run && TERMINAL_STATUS.has(run.status)) stream.close();
    }
  }

  private async drain(runId: string, stream: SseStream, afterSeq: number): Promise<number> {
    let cursor = afterSeq;
    while (!stream.ended) {
      const batch = await this.events.read(this.db, runId, cursor, 200);
      if (batch.length === 0) return cursor;
      for (const event of batch) {
        // `id:` is the run's own seq, so Last-Event-ID is a real cursor rather than an
        // opaque token the client cannot reason about.
        const wrote = stream.event(event.seq, event.type, {
          seq: event.seq,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: event.payload,
        });
        cursor = event.seq;
        if (!wrote) {
          // A slow client must not balloon the buffer. Close instead: it reconnects with
          // Last-Event-ID and loses nothing.
          this.metrics.increment('sse_dropped_slow_client');
          stream.close();
          return cursor;
        }
        if (TERMINAL_EVENT.has(event.type)) {
          stream.close();
          return cursor;
        }
      }
    }
    return cursor;
  }

  /** Backs `mode: sync` — the run is durable either way; this only waits for it. */
  async awaitTerminal(runId: string, timeoutMs: number): Promise<{ status: string; output?: unknown; error?: unknown }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.db
        .selectFrom('runs')
        .select(['status', 'output', 'error'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run) return { status: 'not_found' };
      if (['completed', 'failed', 'cancelled', 'dead_letter'].includes(run.status)) {
        return { status: run.status, output: run.output, error: run.error };
      }
      if (Date.now() > deadline) {
        // Not an error: §18.4 says a sync client that gives up leaves the run executing
        // and resumable by id.
        return { status: run.status };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
