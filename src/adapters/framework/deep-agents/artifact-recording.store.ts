import { Logger } from '@nestjs/common';
import { BaseStore } from '@langchain/langgraph-checkpoint';
import type { Operation, OperationResults } from '@langchain/langgraph-checkpoint';
import type { RunHost } from '../../../domain/ports/framework-adapter.port.js';

/**
 * Decorates any `BaseStore` so that a real file write also lands an `artifacts` row,
 * without knowing or caring how the underlying store keeps its bytes.
 *
 * ## Why a decorator rather than folding this into `ObjectStoreAgentStore`
 *
 * `ObjectStoreAgentStore` backs both `/workspace` (per this file's whole reason to exist)
 * and `/skills` (§13.2-adjacent -- skill content read from the same MinIO-backed store, not
 * re-derived per run). Only `/workspace` writes are agent-authored content someone should be
 * able to find through `GET /v1/artifacts`; a skill's content already has its own governed
 * home in `skill_versions` and would only get a second, redundant, un-versioned row here.
 * `DeepAgentsAdapter` wraps ONE `StoreBackend`'s store in this, not the other, which is a
 * one-line difference instead of a flag threaded through the shared singleton.
 *
 * ## Why this goes through `RunHost.recordArtifact` rather than `ArtifactService` directly
 *
 * `ArtifactService` lives in `DomainModule`, which imports `AdaptersModule` for its port
 * bindings -- this class lives in the adapters band, so depending on `ArtifactService`
 * directly would be a circular module dependency, not merely an ugly one. `RunHost` is
 * already the narrow, domain-owned surface a framework adapter is allowed to call into (see
 * `saveState` for the existing example); `recordArtifact` is one more door on the same
 * surface, and the run/thread attribution happens on the other side of it, where `run` is
 * already in scope, rather than being threaded through here.
 *
 * ## Why the artifact write can fail without failing the file write
 *
 * The durability guarantee this whole change exists for is "the file survives a worker
 * restart," which is already true the moment `inner.batch()` returns. A row in `artifacts`
 * is a DISCOVERABILITY feature layered on top -- useful, but a `GET /v1/artifacts` outage
 * failing an agent's `write_file` call would be the tail making the durable thing less
 * durable than it already was before this wrapper existed. `RunHost.recordArtifact` is
 * documented as best-effort on its own side too; this is the belt its contract asks for.
 */
export class ArtifactRecordingStore extends BaseStore {
  private readonly log = new Logger(ArtifactRecordingStore.name);

  constructor(
    private readonly inner: BaseStore,
    private readonly host: Pick<RunHost, 'recordArtifact'>,
  ) {
    super();
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results = await this.inner.batch(operations);
    // After, not before: recording bytes the underlying write refused (op failed, threw,
    // never reached here) would create an artifact for a file that does not exist.
    await Promise.all(operations.map((op) => this.maybeRecord(op)));
    return results;
  }

  private async maybeRecord(op: Operation): Promise<void> {
    if (!('value' in op)) return; // a get, search or listing
    if (op.value === null) return; // a delete
    const body = bodyOf(op.value);
    if (!body) return; // not file-shaped -- e.g. a skill document's own value shape

    try {
      await this.host.recordArtifact({
        body,
        mediaType: typeof op.value['mimeType'] === 'string' ? (op.value['mimeType'] as string) : 'application/octet-stream',
        metadata: { workspacePath: op.key, namespace: op.namespace },
      });
    } catch (err) {
      this.log.warn(
        `workspace write to ${op.key} succeeded but recording it as an artifact failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * `StoreBackend`'s own `convertFileDataToStoreValue` shape: `{content, mimeType?,
 * created_at, modified_at}`, where `content` is a string, an array of lines (the older
 * FileData v1 shape), or raw bytes. Anything else is a value this store did not put there
 * for file-write purposes -- e.g. a skill document -- and is left unrecorded rather than
 * guessed at.
 */
function bodyOf(value: Record<string, unknown>): Buffer | undefined {
  const content = value['content'];
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (Array.isArray(content) && content.every((line) => typeof line === 'string')) {
    return Buffer.from((content as string[]).join('\n'), 'utf8');
  }
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return undefined;
}
