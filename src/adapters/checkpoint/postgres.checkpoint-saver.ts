import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Database } from '../../platform/persistence/schema.types.js';
import type { Kysely } from 'kysely';
import { PlatformError } from '../../domain/errors/platform.errors.js';

/**
 * LangGraph's `BaseCheckpointSaver`, backed by Postgres.
 *
 * This class is the whole of "an agent survives a pod restart". ap-executor runs the same
 * DeepAgents loop and loses a run on restart purely because it has no database to point
 * this interface at -- the capability was always available, the storage was not.
 *
 * ## Tenancy
 *
 * `BaseCheckpointSaver` only knows about thread ids, so `org_id` travels in the
 * RunnableConfig's `configurable` alongside `thread_id`. It is REQUIRED, and a missing one
 * throws rather than defaulting: a checkpoint holds a run's entire conversation state, so
 * a row written without a tenant would sit outside every RLS policy in 0020 and 0023 and
 * be readable by the next tenant to ask. Failing the write is the safe direction.
 *
 * ## Serialization
 *
 * Values go through the inherited `serde` rather than `JSON.stringify`. LangGraph state
 * holds Message classes and Maps, and the serializer is allowed to choose an encoding JSON
 * cannot round-trip -- so the type tag it returns is stored beside the bytes and handed
 * back on load.
 */
export class PostgresCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Kysely<Database>) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, ns } = scopeOf(config);
    const checkpointId = config.configurable?.['checkpoint_id'] as string | undefined;

    let q = this.db
      .selectFrom('langgraph_checkpoints')
      .selectAll()
      .where('thread_id', '=', threadId)
      .where('checkpoint_ns', '=', ns);

    // No id means "the latest on this thread", which is what a resume asks for. Ordering
    // by checkpoint_id rather than created_at: the ids are time-ordered by construction,
    // so this does not depend on clocks agreeing across writers.
    q = checkpointId
      ? q.where('checkpoint_id', '=', checkpointId)
      : q.orderBy('checkpoint_id', 'desc').limit(1);

    const row = await q.executeTakeFirst();
    if (!row) return undefined;

    return {
      config: { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: row.checkpoint_id } },
      checkpoint: (await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)) as Checkpoint,
      metadata: row.metadata as unknown as CheckpointMetadata,
      ...(row.parent_checkpoint_id
        ? {
            parentConfig: {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            },
          }
        : {}),
      pendingWrites: await this.pendingWrites(threadId, ns, row.checkpoint_id),
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, ns } = scopeOf(config);

    let q = this.db
      .selectFrom('langgraph_checkpoints')
      .selectAll()
      .where('thread_id', '=', threadId)
      .where('checkpoint_ns', '=', ns)
      .orderBy('checkpoint_id', 'desc');

    // `before` is exclusive and expressed as a config, not an id -- pagination walks
    // backwards through history from a checkpoint the caller already holds.
    const before = options?.before?.configurable?.['checkpoint_id'] as string | undefined;
    if (before) q = q.where('checkpoint_id', '<', before);
    if (options?.limit) q = q.limit(options.limit);

    for (const row of await q.execute()) {
      yield {
        config: { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: row.checkpoint_id } },
        checkpoint: (await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)) as Checkpoint,
        metadata: row.metadata as unknown as CheckpointMetadata,
        ...(row.parent_checkpoint_id
          ? {
              parentConfig: {
                configurable: {
                  thread_id: threadId,
                  checkpoint_ns: ns,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              },
            }
          : {}),
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { threadId, ns, orgId } = scopeOf(config, { requireOrg: true });
    const [type, bytes] = await this.serde.dumpsTyped(checkpoint);

    await this.db
      .insertInto('langgraph_checkpoints')
      .values({
        org_id: orgId!,
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
        // The config's checkpoint_id is the one we are descending FROM, which is what
        // makes the parent chain a chain rather than a flat list -- `getDeltaChannelHistory`
        // walks it, and a fork shares ancestors with its origin.
        parent_checkpoint_id: (config.configurable?.['checkpoint_id'] as string | undefined) ?? null,
        type,
        checkpoint: Buffer.from(bytes),
        metadata: JSON.stringify(metadata),
      })
      // A retried super-step can re-put the same id; replacing is correct because the
      // checkpoint is derived from the same state, and failing would strand the run.
      .onConflict((oc) =>
        oc.columns(['thread_id', 'checkpoint_ns', 'checkpoint_id']).doUpdateSet({
          checkpoint: Buffer.from(bytes),
          metadata: JSON.stringify(metadata),
          type,
        }),
      )
      .execute();

    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    if (writes.length === 0) return;
    const { threadId, ns, orgId } = scopeOf(config, { requireOrg: true });
    const checkpointId = config.configurable?.['checkpoint_id'] as string | undefined;
    if (!checkpointId) {
      throw new PlatformError('internal', 'putWrites requires a checkpoint_id in config');
    }

    const rows = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return {
          org_id: orgId!,
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpointId,
          task_id: taskId,
          idx,
          channel,
          type,
          value: Buffer.from(bytes),
        };
      }),
    );

    await this.db
      .insertInto('langgraph_checkpoint_writes')
      .values(rows)
      // Same reasoning as `put`: a task that is retried writes the same (task_id, idx)
      // again, and the later value is the one that happened.
      .onConflict((oc) =>
        oc
          .columns(['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx'])
          .doUpdateSet((eb) => ({
            channel: eb.ref('excluded.channel'),
            type: eb.ref('excluded.type'),
            value: eb.ref('excluded.value'),
          })),
      )
      .execute();
  }

  async deleteThread(threadId: string): Promise<void> {
    // Writes first: they carry no FK to the checkpoint row, so deleting in the other order
    // would leave orphans that a later thread reusing the id would inherit.
    await this.db
      .deleteFrom('langgraph_checkpoint_writes')
      .where('thread_id', '=', threadId)
      .execute();
    await this.db.deleteFrom('langgraph_checkpoints').where('thread_id', '=', threadId).execute();
  }

  private async pendingWrites(
    threadId: string,
    ns: string,
    checkpointId: string,
  ): Promise<[string, string, unknown][]> {
    const rows = await this.db
      .selectFrom('langgraph_checkpoint_writes')
      .selectAll()
      .where('thread_id', '=', threadId)
      .where('checkpoint_ns', '=', ns)
      .where('checkpoint_id', '=', checkpointId)
      .orderBy('task_id')
      .orderBy('idx')
      .execute();

    return Promise.all(
      rows.map(
        async (r) =>
          [
            r.task_id,
            r.channel,
            r.value ? await this.serde.loadsTyped(r.type ?? 'json', r.value) : null,
          ] as [string, string, unknown],
      ),
    );
  }
}

function scopeOf(
  config: RunnableConfig,
  opts?: { requireOrg?: boolean },
): { threadId: string; ns: string; orgId: string | undefined } {
  const threadId = config.configurable?.['thread_id'] as string | undefined;
  if (!threadId) {
    throw new PlatformError('internal', 'checkpointer requires a thread_id in config');
  }
  const orgId = config.configurable?.['org_id'] as string | undefined;
  if (opts?.requireOrg && !orgId) {
    // Refused rather than defaulted -- see the class comment on tenancy.
    throw new PlatformError(
      'internal',
      'checkpointer requires an org_id in config; an untenanted checkpoint would sit outside RLS',
    );
  }
  return { threadId, ns: (config.configurable?.['checkpoint_ns'] as string | undefined) ?? '', orgId };
}
