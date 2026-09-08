import { z } from 'zod';

/**
 * A policy document (§17.3).
 *
 * "Policies are versioned resources referenced by many agents, so a residency or spend
 * rule updates in one place rather than across fifty specs." The list §17.3 names is the
 * list below: tool permissions, model restrictions, data residency, spend limits, human
 * approval requirements, and trust boundaries.
 *
 * **A policy only ever NARROWS.** It is another term in §16.2's intersection --
 * `effective = spec ∩ service grant ∩ user grant ∩ policy` -- and it can refuse things
 * the spec asked for, never grant things it did not. An `allow` list is therefore a
 * restriction ("only these"), not a grant: a tool absent from the capability grants stays
 * refused no matter what any policy says. Written this way round because the opposite is
 * the classic policy-engine bug, where a policy edit quietly widens fifty agents at once.
 *
 * `.strict()` for the same reason the AgentSpec is: a typo'd key in a security document
 * must fail loudly at publish, not be ignored until an audit.
 */
export const policyDocumentSchema = z
  .object({
    /** Tool permissions. `allow` is an allowlist; `deny` wins over it. */
    tools: z
      .object({
        allow: z.array(z.string().min(1)).max(256).nullable().default(null),
        deny: z.array(z.string().min(1)).max(256).default([]),
      })
      .strict()
      .default({ allow: null, deny: [] }),

    /** Model restrictions, by registry ref. */
    models: z
      .object({
        allow: z.array(z.string().min(1)).max(128).nullable().default(null),
        deny: z.array(z.string().min(1)).max(128).default([]),
      })
      .strict()
      .default({ allow: null, deny: [] }),

    /**
     * The strongest residency this policy permits an agent to reach (§16.1 Constraint 2).
     *
     * `internal` means the agent may not reach an external model, MCP server or peer even
     * if its own `security.dataClass` is `internal` and the registry entry exists. This is
     * the "a residency rule updates in one place" case §17.3 opens with.
     */
    residency: z.enum(['internal', 'external']).nullable().default(null),

    /** Spend ceiling. Applied as a MINIMUM with the spec's own limit -- see enforce(). */
    maxCostMicros: z.number().int().nonnegative().nullable().default(null),

    /** Tools that may only run behind a human approval gate (§14), whatever the spec says. */
    requireApprovalFor: z.array(z.string().min(1)).max(256).default([]),

    /** Trust boundaries: which A2A peers this agent may call (§13.6). */
    peers: z
      .object({
        allow: z.array(z.string().min(1)).max(128).nullable().default(null),
        deny: z.array(z.string().min(1)).max(128).default([]),
      })
      .strict()
      .default({ allow: null, deny: [] }),

    /** Sub-agent delegation, off in one place for an agent that must not fan out (§13.3). */
    allowSubAgents: z.boolean().default(true),

    /** Free text for the humans reading an audit, never interpreted. */
    description: z.string().max(2_000).nullable().default(null),
  })
  .strict();

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

/** The parts of a spec a policy can speak about. Kept narrow so enforce() stays pure. */
export interface PolicySubject {
  modelRef: string;
  modelResidency: 'internal' | 'external';
  tools: string[];
  peers: { name: string; residency: 'internal' | 'external' }[];
  subAgents: string[];
  maxCostMicros: number | null;
}

export interface PolicyVerdict {
  /** Collected, never short-circuited -- an author should see every violation at once. */
  rejections: string[];
  /**
   * The cost ceiling after applying the policy: the MINIMUM of the spec's and the
   * policy's. A spec asking for more than the policy allows is narrowed rather than
   * refused, because a ceiling is the one case where "less than you asked for" is
   * unambiguously the safe answer and refusing would just make authors guess the limit.
   */
  effectiveMaxCostMicros: number | null;
  /** Tools the policy forces behind an approval gate, on top of their own effects. */
  approvalRequired: string[];
}

const listed = (value: string, list: string[]): boolean =>
  list.some((entry) => entry.toLowerCase() === value.toLowerCase());

/**
 * Applies a policy to a spec's resolved subject.
 *
 * Pure: no database, no context, no clock. That is what makes the policy testable as a
 * table of cases and what keeps the enforcement point honest -- every caller gets the same
 * verdict for the same inputs.
 */
export function enforcePolicy(doc: PolicyDocument, subject: PolicySubject): PolicyVerdict {
  const rejections: string[] = [];

  // deny is evaluated before allow throughout: a denylist is the control someone reaches
  // for during an incident, and it must not be defeatable by also appearing on an allowlist.
  if (listed(subject.modelRef, doc.models.deny)) {
    rejections.push(`policy: model "${subject.modelRef}" is denied by policy`);
  } else if (doc.models.allow && !listed(subject.modelRef, doc.models.allow)) {
    rejections.push(
      `policy: model "${subject.modelRef}" is not in the policy's allowed models ` +
        `(${doc.models.allow.join(', ')})`,
    );
  }

  for (const ref of subject.tools) {
    if (listed(ref, doc.tools.deny)) {
      rejections.push(`policy: tool "${ref}" is denied by policy`);
    } else if (doc.tools.allow && !listed(ref, doc.tools.allow)) {
      rejections.push(`policy: tool "${ref}" is not in the policy's allowed tools`);
    }
  }

  for (const peer of subject.peers) {
    if (listed(peer.name, doc.peers.deny)) {
      rejections.push(`policy: peer "${peer.name}" is denied by policy`);
    } else if (doc.peers.allow && !listed(peer.name, doc.peers.allow)) {
      rejections.push(`policy: peer "${peer.name}" is not in the policy's allowed peers`);
    }
  }

  // §16.1 Constraint 2 in one place. The model gateway enforces the agent's OWN data class
  // per call; this is the org-level rule layered on top, so tightening it does not require
  // touching fifty specs.
  if (doc.residency === 'internal') {
    if (subject.modelResidency === 'external') {
      rejections.push(
        `policy: model "${subject.modelRef}" is external, and this policy permits internal residency only (§16.1)`,
      );
    }
    for (const peer of subject.peers) {
      if (peer.residency === 'external') {
        rejections.push(
          `policy: peer "${peer.name}" is external, and this policy permits internal residency only (§16.1)`,
        );
      }
    }
  }

  if (!doc.allowSubAgents && subject.subAgents.length > 0) {
    rejections.push(
      `policy: sub-agent delegation is disabled by policy, but the spec names ` +
        `${subject.subAgents.join(', ')}`,
    );
  }

  const effectiveMaxCostMicros =
    doc.maxCostMicros === null
      ? subject.maxCostMicros
      : subject.maxCostMicros === null
        ? doc.maxCostMicros
        : Math.min(doc.maxCostMicros, subject.maxCostMicros);

  // Only tools the spec actually names. Listing a tool the agent never asked for is not a
  // violation, and reporting it as one would make a shared policy unusable across agents.
  const approvalRequired = subject.tools.filter((ref) => listed(ref, doc.requireApprovalFor));

  return { rejections, effectiveMaxCostMicros, approvalRequired };
}
