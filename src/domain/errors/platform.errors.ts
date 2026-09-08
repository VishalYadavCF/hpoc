/** Typed taxonomy. Saturation is not a 500, and a caller must be able to act on the difference. */
export type ErrorCode =
  | 'admission_rejected'
  | 'capability_denied'
  | 'throttled'
  | 'shed'
  | 'budget_exhausted'
  | 'invalid_transition'
  | 'not_found'
  | 'upstream_failure'
  | 'lease_lost'
  | 'indeterminate_side_effect'
  | 'internal';

export class PlatformError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AdmissionRejected extends PlatformError {
  constructor(readonly rejections: string[]) {
    super('admission_rejected', 'Spec rejected by admission control', { rejections });
  }
}

export class CapabilityDenied extends PlatformError {
  constructor(resourceKind: string, resourceId: string) {
    // §16.2: absence of a grant is a rejection, never a fallback to service identity.
    super('capability_denied', `No grant for ${resourceKind} ${resourceId}`, {
      resourceKind,
      resourceId,
    });
  }
}

export class Saturated extends PlatformError {
  constructor(
    policy: 'throttle' | 'shed',
    readonly level: string,
    readonly scopeRef: string,
    readonly retryAfterSeconds: number,
  ) {
    // level and scopeRef matter: backing off from a tenant limit and from an MCP server
    // limit are different behaviours, and without them the caller cannot tell which it hit.
    super(policy === 'throttle' ? 'throttled' : 'shed', `Saturated at ${level}:${scopeRef}`, {
      level,
      scopeRef,
      retryAfterSeconds,
    });
  }
}

/**
 * §5.2: a budget is a governance signal at one level of the tenancy hierarchy. `level`
 * and `scopeRef` matter for the same reason `Saturated` carries them -- a tenant that
 * exhausted its own daily budget and a namespace that exhausted its monthly one are
 * different situations, and a caller cannot tell which without them.
 */
export class BudgetExhausted extends PlatformError {
  constructor(
    readonly level: string,
    readonly scopeRef: string,
    readonly period: string,
  ) {
    super('budget_exhausted', `Budget exhausted at ${level}:${scopeRef} (${period})`, {
      level,
      scopeRef,
      period,
    });
  }
}

export class NotFound extends PlatformError {
  constructor(kind: string, id: string) {
    super('not_found', `${kind} ${id} not found`, { kind, id });
  }
}

export class InvalidTransition extends PlatformError {
  constructor(from: string, to: string) {
    super('invalid_transition', `Cannot move a run from ${from} to ${to}`, { from, to });
  }
}

/**
 * The lease was reclaimed while this worker held it. Abandon locally: do not retry,
 * do not roll forward. Another worker owns the run now.
 */
export class LeaseLost extends PlatformError {
  constructor(runId: string) {
    super('lease_lost', `Lease for run ${runId} is no longer held`, { runId });
  }
}

/**
 * A non-idempotent tool invocation was found still `running` after a crash.
 *
 * §4.5: we do not know whether the side effect happened, so we may not retry and may
 * not assume success. This is the honest outcome rather than a fabricated one.
 */
export class IndeterminateSideEffect extends PlatformError {
  constructor(invocationId: string, toolRef: string) {
    super(
      'indeterminate_side_effect',
      `Tool ${toolRef} is non-idempotent and its outcome is unknown after a crash`,
      { invocationId, toolRef },
    );
  }
}
