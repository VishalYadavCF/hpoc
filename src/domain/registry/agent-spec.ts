import { z } from 'zod';

/**
 * The inline AgentSpec accepted by POST /v1/runs (§18.1, §19 in miniature).
 *
 * Deliberately narrow: an inline spec SELECTS from capability the caller already holds,
 * it never widens authority (§18.5). Note what is absent — there is no inline MCP server
 * definition, because that would bypass hash pinning and tenant approval. Servers are
 * referenced by registry id or not at all.
 */
/**
 * A tool defined in the spec rather than selected from the registry.
 *
 * Everything here describes the CALL. Nothing here describes the CONTRACT -- see the
 * `tools` field for why that separation is the whole security argument.
 */
export const inlineToolSchema = z.object({
  /**
   * The template being instantiated, as `ref` or `ref@2`. The caller must hold a grant
   * for it, exactly as it would for a tool.
   */
  template: z.string().min(1).max(200),
  /**
   * The name the MODEL sees, and the ref the invocation is recorded under.
   *
   * Constrained to what every vendor accepts in a tool name: a legal name must never fail
   * at the provider, and a name with a slash in it would be silently dropped from the
   * tool list by some of them.
   */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, 'tool names are [A-Za-z0-9_.-]'),
  /** What the model reads to decide whether to call it. */
  description: z.string().min(1).max(1_000),
  /** JSON Schema for the arguments the MODEL supplies. `fixedArgs` are not in here. */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  /** Must be one of the template's `allowedMethods`. */
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).nullable().default(null),
  /**
   * RFC 6570 path, which must sit under the template's `pathPrefix`.
   *
   * `{name}` is one percent-encoded segment, so an argument cannot invent a path segment
   * the template did not declare -- which is what stops an instantiation walking out of
   * its prefix with a value rather than with a template.
   */
  pathTemplate: z.string().min(1).max(500).nullable().default(null),
  /** Where arguments the path did not consume go. NULL means by method. */
  argPlacement: z.enum(['query', 'body', 'none']).nullable().default(null),
  /**
   * Arguments bound by the platform, which the model never sees (ai-agent's `fixed` field
   * mode).
   *
   * Merged in AFTER the model answers and stripped from the schema it was shown, so a
   * pinned value cannot be argued with, hallucinated differently, or leaked into context.
   */
  fixedArgs: z.record(z.string(), z.unknown()).default({}),
});

export type InlineToolSpec = z.infer<typeof inlineToolSchema>;

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
    /**
     * Tools this agent may call: a registry ref, or an inline definition (§18.5).
     *
     * A bare string still means "select a tool I already hold a grant for", which is what
     * every registered agent should use. The object form INSTANTIATES a `toolTemplate`,
     * for the case §18.1 exists to serve: ap-executor's workflow author picks a piece and
     * an action in the node, and there is no registration step to hang a tool row on.
     *
     * The split that makes this safe: the spec supplies the SHAPE, the template supplies
     * the CONTRACT. Effects, residency, sandbox profile, timeout and the reachable origin
     * all come from the template and are not expressible here. A caller that could declare
     * its own effects would self-declare a payment tool `readOnly`, skip its approval gate
     * and have the result cached -- §4.5 and §8.3 would become advisory.
     */
    tools: z
      .array(z.union([z.string().min(1), inlineToolSchema]))
      .max(64)
      .default([]),
    /**
     * Sub-agents by name, resolved within the caller's OWN namespace (§13.3).
     *
     * Cross-namespace invocation is not expressible here and never will be: the ownership
     * boundary is the protocol boundary, and reaching another team's agent goes over A2A.
     * The schema enforces it structurally through a composite foreign key, so this is a
     * convenience check rather than the control.
     */
    subAgents: z
      .array(
        z.union([
          // A bare name still means the §13.3 default: a separate run.
          z.string().min(1),
          z.object({
            name: z.string().min(1),
            /**
             * How the sub-agent executes.
             *
             * `run` (default) — a SEPARATE run: its own lifecycle, checkpoints, retries,
             * budget ceiling and dead-lettering, and the caller suspends to `waiting`
             * until it settles. This is §13.3 as written.
             *
             * `inline` — the child reasons INSIDE this run, as a DeepAgents sub-agent
             * with its own prompt, model and tools resolved from its own version. It gets
             * a fresh context window and returns in milliseconds instead of a queue round
             * trip. What it gives up is everything that lives on a run row: no separate
             * budget ceiling of its own beyond the one checked here, no retries, no
             * dead-letter, and its failure returns to the caller's reasoning rather than
             * becoming a run someone can inspect and resume.
             *
             * Choose `inline` for a fast, well-scoped stage whose cost is bounded by its
             * caller's. Choose `run` when the stage needs to be governed, retried or
             * operated on its own terms.
             */
            mode: z.enum(['run', 'inline']).default('run'),
          }),
        ]),
      )
      .max(16)
      .default([])
      .transform((entries) =>
        entries.map((e) => (typeof e === 'string' ? { name: e, mode: 'run' as const } : e)),
      ),

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
     * In-process helpers: the same agent thinking in a fresh context (§7, §13.3).
     *
     * Distinct from `subAgents`, which names REGISTERED agents someone else owns and
     * versions. One of those has its own model, tools, policy and budget ceiling, and
     * running it in this process would silently use the CALLER's model and tool grants --
     * a cheap classifier stage would quietly run on the expensive model. So a registered
     * sub-agent is always a separate run.
     *
     * An inline helper has none of that: no version, no policy of its own, no separate
     * budget. It is a prompt and a narrower tool list, and its whole value is a clean
     * context window -- a forty-call research detour that does not have to sit in the main
     * transcript for the rest of the run.
     *
     * `tools` may only NARROW the agent's own bound tools. Naming one it does not have
     * grants nothing: the platform refuses anything unbound at execution regardless, so
     * the list is about focus, not authority.
     */
    inlineSubAgents: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(64)
            // The model selects a helper by this name through the `task` tool, and every
            // vendor constrains tool arguments it validates; keeping the charset tight
            // here means a legal name never fails at the provider.
            .regex(/^[A-Za-z0-9_-]+$/, 'inline sub-agent names are [A-Za-z0-9_-]'),
          description: z.string().min(1).max(500),
          prompt: z.string().min(1).max(8_000),
          /** A subset of the agent's own tools. Omitted means all of them. */
          tools: z.array(z.string().min(1)).max(64).nullable().default(null),
          /** Pinned skills, by name, this helper should see. Omitted means none. */
          skills: z.array(z.string().min(1)).max(16).default([]),
        }),
      )
      .max(8)
      .default([]),

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
