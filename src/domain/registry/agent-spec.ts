import { z } from 'zod';

/**
 * The inline AgentSpec accepted by POST /v1/runs (§18.1, §19 in miniature).
 *
 * Deliberately narrow: an inline spec SELECTS from capability the caller already holds,
 * it never widens authority (§18.5). Note what is absent — there is no inline MCP server
 * definition, because that would bypass hash pinning and tenant approval. Servers are
 * referenced by registry id or not at all.
 */
export const agentSpecSchema = z
  .object({
    framework: z.enum(['echo', 'pipeline', 'deep-agents']).default('echo'),
    model: z.object({ ref: z.string().min(1) }),
    /**
     * An inline system prompt. Mutually exclusive with `promptRef` — see the refine below.
     *
     * Kept for ephemeral specs, where §18.1's whole point is that a caller can describe an
     * agent without registering anything. A registered agent should prefer `promptRef`.
     */
    systemPrompt: z.string().max(32_000).nullable().default(null),

    /**
     * A prompt from the registry (§17.2), as `name` or `name@3`.
     *
     * A bare name resolves to the highest APPROVED version, and the resolution happens
     * once, at admission: what the agent version stores is a prompt_version_id, so
     * publishing a new prompt version never changes a running agent.
     */
    promptRef: z.string().min(1).max(200).nullable().default(null),

    /**
     * A policy from the registry (§17.3), as `name` or `name@3`.
     *
     * Resolved and ENFORCED once at admission, and the version id is pinned onto the agent
     * version. A policy narrows what this spec may reach -- tools, models, residency,
     * spend, peers -- so tightening the policy refuses the next publish rather than
     * silently changing a running agent.
     */
    policyRef: z.string().min(1).max(200).nullable().default(null),
    tools: z.array(z.string().min(1)).max(64).default([]),
    /**
     * Sub-agents by name, resolved within the caller's OWN namespace (§13.3).
     *
     * Cross-namespace invocation is not expressible here and never will be: the ownership
     * boundary is the protocol boundary, and reaching another team's agent goes over A2A.
     * The schema enforces it structurally through a composite foreign key, so this is a
     * convenience check rather than the control.
     */
    subAgents: z.array(z.string().min(1)).max(16).default([]),

    /**
     * Skills by ref: `name` for the highest active version, or `name@3` to pin.
     *
     * Resolved to an immutable version id ONCE, at admission. A bare name is a
     * convenience for the author, not a late binding -- once the version exists, the
     * skill it runs cannot change under it. A skill that carries tools widens capability,
     * so every one of them is intersected with the caller's grants (§16.2) exactly as a
     * directly-named tool is; attaching a skill is not a way around a missing grant.
     */
    skills: z.array(z.string().min(1)).max(32).default([]),

    /**
     * A2A (§13.4, Appendix A).
     *
     * `peers` are named from the ORG-wide registry, not the namespace — that asymmetry
     * with `subAgents` is the whole point of §13.3. A sub-agent is same-team, same trust
     * domain, same run; a peer is another team's, and crossing that boundary is what A2A
     * is for. The registry resolves whether a peer happens to run in this process.
     *
     * `exposeAsPeer` publishes a signed Agent Card derived from this spec (§13.6) — the
     * way a Kubernetes Service acquires DNS. It is not a second registration.
     */
    a2a: z
      .object({
        version: z.string().default('0.3.0'),
        exposeAsPeer: z.boolean().default(false),
        peers: z.array(z.string().min(1)).max(16).default([]),
      })
      .default({ version: '0.3.0', exposeAsPeer: false, peers: [] }),

    /**
     * Knowledge collections read directly, without a skill in between (§6.1 semantic).
     *
     * Separate from `memory` because they are separate things. Memory is learned from
     * this tenant's runs and decays; a collection is authored, namespace-wide and
     * corrected by re-ingesting the document. An agent commonly wants one, the other, or
     * both, and collapsing them would make "the agent remembered something" and "the
     * agent looked something up" indistinguishable in the trace.
     */
    knowledge: z
      .object({
        collections: z.array(z.string().min(1)).max(16).default([]),
        recallLimit: z.number().int().positive().max(50).default(5),
      })
      .default({ collections: [], recallLimit: 5 }),
    /** §7, and §0.5: every mechanism here is individually disableable per agent. */
    context: z
      .object({
        maxChars: z.number().int().positive().max(2_000_000).default(24_000),
        reserveForAnswer: z.number().int().nonnegative().default(4_000),
        compaction: z.boolean().default(true),
        eviction: z.boolean().default(true),
      })
      .default({ maxChars: 24_000, reserveForAnswer: 4_000, compaction: true, eviction: true }),

    // §0.5: each compensating mechanism is individually disableable per agent, and one
    // that cannot be shown to help is removed. Memory defaults OFF for that reason --
    // an agent should opt into a mechanism, not inherit it and never measure it.
    memory: z
      .object({
        enabled: z.boolean().default(false),
        tiers: z
          .array(z.enum(['working', 'conversational', 'semantic', 'episodic', 'procedural', 'external']))
          .default(['conversational', 'episodic']),
        recallLimit: z.number().int().positive().max(50).default(5),
        retentionSeconds: z.number().int().positive().nullable().default(null),
      })
      .default({ enabled: false, tiers: ['conversational', 'episodic'], recallLimit: 5, retentionSeconds: null }),

    /**
     * §10. Model responses are cached ONLY where the agent declares determinism is
     * acceptable — inferring it would silently make a non-deterministic agent repeat
     * itself, which for a conversational agent is worse than paying for the call.
     */
    cache: z
      .object({
        modelResponses: z.boolean().default(false),
        ttlSeconds: z.number().int().positive().max(86_400).default(300),
      })
      .default({ modelResponses: false, ttlSeconds: 300 }),

    /**
     * JSON Schema the final answer must satisfy.
     *
     * The platform had no way to say this before. A consuming service that needed a shape
     * -- and a workflow builder needs one for every node it emits -- had to ask for JSON in
     * the prompt and parse whatever came back, which is where a trailing comma or a
     * markdown fence turns a correct answer into a failed run. Handed to the framework,
     * which uses the provider's own structured-output mechanism where one exists.
     */
    responseSchema: z.record(z.string(), z.unknown()).nullable().default(null),

    /**
     * Per-model prompt tuning, applied AFTER the resolved system prompt (§17.2).
     *
     * Separate from `systemPrompt` because the two are versioned by different people on
     * different cadences: the prompt is an authored, registry-governed artifact, and this
     * is the small nudge a particular model needs to follow it. Folding the nudge into the
     * prompt would mean a new prompt version -- and a new eval baseline -- every time a
     * model is swapped.
     */
    harness: z
      .object({ systemPromptSuffix: z.string().max(4_000).nullable().default(null) })
      .default({ systemPromptSuffix: null }),

    // §16.1 Constraint 2. Without this the residency gate is unreachable from the
    // ephemeral path, which makes a security control decorative -- the spec could name an
    // external model and nothing would object.
    security: z
      .object({ dataClass: z.enum(['internal', 'regulated']).default('internal') })
      .default({ dataClass: 'internal' }),
    execution: z
      .object({
        durability: z.enum(['strict', 'relaxed']).default('strict'),
        limits: z
          .object({
            maxSteps: z.number().int().positive().max(1_000).default(50),
            maxCostMicros: z.number().int().nonnegative().nullable().default(null),
          })
          .default({ maxSteps: 50, maxCostMicros: null }),
      })
      .default({ durability: 'strict', limits: { maxSteps: 50, maxCostMicros: null } }),
  })
  .strict()
  .refine((spec) => !(spec.systemPrompt && spec.promptRef), {
    // Refused rather than given a precedence rule. A rule ("the ref wins") is one nobody
    // remembers under pressure, and the failure is silent: the agent runs with a prompt
    // its author did not think they had selected.
    message:
      'systemPrompt and promptRef are mutually exclusive — name one or the other, not both',
    path: ['promptRef'],
  });

export type AgentSpec = z.infer<typeof agentSpecSchema>;
