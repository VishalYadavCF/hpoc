import { BaseStore } from '@langchain/langgraph-checkpoint';
import type { Operation, OperationResults } from '@langchain/langgraph-checkpoint';
import { PlatformError } from '../../../domain/errors/platform.errors.js';

/**
 * Decorates a `BaseStore` so nothing but the seeding code that owns it can ever write
 * through it -- the counterpart to `PlatformBackend`'s `readOnly: Set<string>` for the
 * `/skills` route, which lost that protection the moment skill content moved off an
 * in-memory map with its own per-path write guard onto a generic, freely-writable
 * `StoreBackend`.
 *
 * ## Why a whole batch is refused, not just its write operations
 *
 * A model calling `edit_file` on a skill sends ONE batch mixing a read (find the string to
 * replace) and a write (store the result). Applying the read half and refusing only the
 * write would still look like partial progress to a caller inspecting the batch; refusing
 * the batch outright is the same discipline `ObjectStoreAgentStore`'s tenancy guard
 * already applies -- fail before touching anything, not after touching some of it.
 *
 * `deep-agents.adapter.ts` seeds skills through a SEPARATE `StoreBackend` built directly
 * on the unwrapped store, sharing this one's namespace; only the route handed to
 * `CompositeBackend` -- what the model actually reaches -- is wrapped in this.
 */
export class ReadOnlyStore extends BaseStore {
  constructor(private readonly inner: BaseStore) {
    super();
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    for (const op of operations) {
      if ('value' in op) {
        throw new PlatformError(
          'internal',
          `Refusing to modify a read-only path (key: ${op.key}): skills are a governed, ` +
            'versioned artifact and cannot be rewritten by a run.',
        );
      }
    }
    return this.inner.batch(operations);
  }
}
