import { Injectable } from '@nestjs/common';
import type { Executor, Tx } from '../../platform/persistence/database.js';
import type { DurabilityTier } from '../../platform/persistence/schema.types.js';
import { stableHash } from '../../platform/ids.js';

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface PendingAction {
  stepId: string;
  toolRef: string;
  args: Record<string, unknown>;
  interactionId: string;
}

/**
 * A delegation the parent is suspended on (§4.6).
 *
 * Recorded on the checkpoint because the parent's own adapter state has already advanced
 * past the delegate call. On resume the platform reads the child's outcome and feeds it
 * back as an observation; without this the parent would ask for its next step and skip
 * the delegation entirely.
 */
export interface PendingDelegation {
  stepId: string;
  alias: string;
  childRunId: string;
}

/**
 * A dispatched peer task the parent is suspended on.
 *
 * `taskId` rather than `childRunId`: for a local binding they are the same value, and for
 * a remote one the id was minted by another runtime. Storing the neutral name is what
 * lets one resume path serve both bindings (§13.4).
 */
export interface PendingPeerCall {
  stepId: string;
  alias: string;
  peerId: string;
  taskId: string;
}

export interface CheckpointState {
  /** Adapter-owned and opaque to the platform -- §0.3 keeps framework shapes out of the model. */
  adapterState: unknown;
  lastObservation: unknown;
  stepSeq: number;
  /**
   * The action a `humanApprovalRequired` gate suspended (§8.3, §14).
   *
   * Without this a resumed run asks the adapter for its next step, and the adapter --
   * whose state already advanced past the tool call -- returns `complete`. The approval
   * would be granted and the approved action silently never executed, which is the worst
   * possible outcome for a gate that exists to authorise side effects.
   */
  pendingAction?: PendingAction | null;
  pendingDelegation?: PendingDelegation | null;
  pendingPeerCall?: PendingPeerCall | null;
}

@Injectable()
export class CheckpointService {
  /**
   * Writes a resumable snapshot at a step boundary (§4.2).
   *
   * At the `strict` tier this is synchronous and in the same transaction as the step, so
   * a crash between the two is impossible. At `relaxed` the caller batches instead --
   * but tool invocations still follow their own effect contract, so an `essential` tool
   * inside a relaxed run is written synchronously regardless of tier (§4.3).
   */
  async write(
    tx: Tx,
    args: {
      runId: string;
      stepSeq: number;
      durability: DurabilityTier;
      state: CheckpointState;
      parentCheckpointId?: string | null;
    },
  ): Promise<string> {
    const row = await tx
      .insertInto('checkpoints')
      .values({
        run_id: args.runId,
        step_seq: args.stepSeq,
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        parent_checkpoint_id: args.parentCheckpointId ?? null,
        state: JSON.stringify(args.state),
        state_hash: stableHash(args.state),
        durability: args.durability,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .updateTable('runs')
      .set({ last_checkpoint_id: row.id })
      .where('id', '=', args.runId)
      .execute();

    return row.id;
  }

  async latest(db: Executor, runId: string): Promise<CheckpointState | null> {
    const row = await db
      .selectFrom('checkpoints')
      .select(['state', 'schema_version'])
      .where('run_id', '=', runId)
      .orderBy('step_seq', 'desc')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row?.state) return null;
    // Checkpoint states carry their own schema_version for the same reason events do:
    // a resumed run must be readable by a newer binary than the one that wrote it.
    return row.state as CheckpointState;
  }
}
