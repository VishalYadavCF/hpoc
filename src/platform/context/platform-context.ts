import { AsyncLocalStorage } from 'node:async_hooks';

export interface DelegationHop {
  runId: string;
  agentVersionId: string;
  principalId: string;
}

/**
 * Identical shape on api and worker, so domain code cannot tell which process it is in.
 *
 * `tenantRef` is not optional: §5.2 makes it a first-class parameter that partitions
 * memory, subdivides quota and gates residency. `onBehalfOfPrincipalId: null` is
 * meaningful rather than missing — it says no interactive user was present, which is a
 * different security posture from an interactive run (see client-interactions/01).
 */
export interface PlatformContext {
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  callerPrincipalId: string;
  onBehalfOfPrincipalId: string | null;
  authorizingHumanId: string | null;
  delegationChain: DelegationHop[];
  traceId: string;
  correlationId: string;
  runId?: string;
  lease?: { owner: string; epoch: string };
}

const storage = new AsyncLocalStorage<PlatformContext>();

export function runInContext<T>(ctx: PlatformContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Throws rather than returning undefined: an unscoped query is a tenancy bug. */
export function requireContext(): PlatformContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No PlatformContext. Every query is tenant-scoped; entering domain code ' +
        'outside runInContext() is a bug, not a special case.',
    );
  }
  return ctx;
}

export function maybeContext(): PlatformContext | undefined {
  return storage.getStore();
}
