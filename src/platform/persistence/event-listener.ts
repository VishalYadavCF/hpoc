import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { LISTENER_POOL } from './tokens.js';

export type Notification = { runId: string; seq: number };
type Handler = (n: Notification) => void;
type ChannelHandler = (payload: string) => void;

export const RUN_EVENTS_CHANNEL = 'run_events';
export const RUN_READY_CHANNEL = 'run_ready';

/**
 * One dedicated connection, multiplexed to many subscribers in-process.
 *
 * The NOTIFY payload is `<runId>:<seq>` and nothing more — the ~8 KB payload cap (§12.1)
 * means the event itself is never carried, only its identity. Subscribers read the row.
 */
@Injectable()
export class EventListener implements OnModuleDestroy {
  private readonly log = new Logger(EventListener.name);
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly channelHandlers = new Map<string, Set<ChannelHandler>>();
  private client?: pg.PoolClient;
  private readonly extraChannels = new Set<string>();
  private connecting?: Promise<void>;
  private stopped = false;

  constructor(@Inject(LISTENER_POOL) private readonly pool: pg.Pool) {}

  async subscribe(runId: string, handler: Handler): Promise<() => void> {
    await this.ensureConnected();
    let set = this.handlers.get(runId);
    if (!set) this.handlers.set(runId, (set = new Set()));
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(runId);
    };
  }

  /**
   * Subscribes to a whole channel rather than one run's events.
   *
   * The worker uses this to wake on `run_ready` instead of waiting for its poll tick.
   * Polling put ~half the poll interval of pure latency in front of every run, which for
   * a conversational agent is the largest single contributor to perceived response time
   * and buys nothing.
   */
  async onChannel(channel: string, handler: ChannelHandler): Promise<() => void> {
    let set = this.channelHandlers.get(channel);
    if (!set) {
      this.channelHandlers.set(channel, (set = new Set()));
      this.extraChannels.add(channel);
    }
    set.add(handler);
    await this.ensureConnected();
    await this.client?.query(`LISTEN ${quoteIdent(channel)}`);
    return () => set!.delete(handler);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.stopped) return;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on('notification', (msg) => {
      if (msg.channel !== RUN_EVENTS_CHANNEL) {
        for (const handler of this.channelHandlers.get(msg.channel) ?? []) {
          try {
            handler(msg.payload ?? '');
          } catch (e) {
            this.log.warn(`channel subscriber threw: ${(e as Error).message}`);
          }
        }
        return;
      }
      if (!msg.payload) return;
      const [runId, rawSeq] = msg.payload.split(':');
      const seq = Number(rawSeq);
      if (!runId || !Number.isFinite(seq)) return;
      for (const handler of this.handlers.get(runId) ?? []) {
        try {
          handler({ runId, seq });
        } catch (e) {
          this.log.warn(`subscriber threw: ${(e as Error).message}`);
        }
      }
    });
    // A dropped listener connection is silent data loss for every open stream, so
    // reconnect rather than degrade. Subscribers survive: they reconnect with
    // Last-Event-ID and replay whatever they missed.
    client.on('error', (e) => {
      this.log.error(`listener connection lost: ${e.message}`);
      this.client = undefined;
      client.release(e);
      if (!this.stopped) setTimeout(() => void this.ensureConnected(), 1_000);
    });
    await client.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
    // Re-established on reconnect: a dropped listener that came back subscribed to only
    // some of its channels is worse than one that stayed down, because it looks healthy.
    for (const channel of this.extraChannels) {
      await client.query(`LISTEN ${quoteIdent(channel)}`);
    }
    this.client = client;
    this.log.log(`listening on ${RUN_EVENTS_CHANNEL}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.client?.release();
    this.client = undefined;
  }
}

/** Channel names are internal constants, never user input; this is belt and braces. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
