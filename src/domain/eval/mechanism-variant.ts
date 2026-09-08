import type { AgentSpec } from '../registry/agent-spec.js';

export type Mechanism =
  | 'summarization' | 'compaction' | 'memory_tiers' | 'planning_scaffold'
  | 'sub_agents' | 'retrieval' | 'eviction' | 'skills' | 'knowledge'
  | 'model_cache' | 'peers' | 'none';

/**
 * Produces the spec with one compensating mechanism turned OFF.
 *
 * This is the mechanical core of §0.5. Every mechanism there is required to be
 * "individually disableable per-agent", and this function is what cashes that in: the
 * "off" arm of an A/B is the same spec with one field flipped.
 *
 * The critical property is that the result is a REAL, ADMISSIBLE SPEC, materialised as
 * its own agent version and executed through the ordinary run engine. The tempting
 * shortcut -- a runtime flag that suppresses memory recall for the duration of an eval --
 * would measure a configuration that can never be deployed, so a "mechanism justified"
 * verdict would be evidence about something nobody can ship.
 *
 * Returns null when the mechanism is already off, or is not expressible in the spec.
 * Null means "no comparison is possible", which is a better answer than a comparison
 * against an identical spec that would report a delta of zero and read as "no benefit".
 */
export function withMechanismDisabled(spec: AgentSpec, mechanism: Mechanism): AgentSpec | null {
  switch (mechanism) {
    case 'memory_tiers':
      // Covers the whole memory mechanism: recall, tiers, and the writes that feed them.
      return spec.memory.enabled ? { ...spec, memory: { ...spec.memory, enabled: false } } : null;

    case 'compaction':
      return spec.context.compaction
        ? { ...spec, context: { ...spec.context, compaction: false } }
        : null;

    case 'eviction':
      return spec.context.eviction
        ? { ...spec, context: { ...spec.context, eviction: false } }
        : null;

    // §7's compaction is implemented by truncation, and the summariser seam feeds
    // consolidation rather than the prompt. Disabling compaction is therefore the closest
    // honest analogue -- named separately so a suite can say which it meant.
    case 'summarization':
      return spec.context.compaction
        ? { ...spec, context: { ...spec.context, compaction: false } }
        : null;

    case 'retrieval':
    case 'knowledge':
      return spec.knowledge.collections.length > 0
        ? { ...spec, knowledge: { ...spec.knowledge, collections: [] } }
        : null;

    case 'skills':
      return spec.skills.length > 0 ? { ...spec, skills: [] } : null;

    case 'sub_agents':
    case 'planning_scaffold':
      return spec.subAgents.length > 0 ? { ...spec, subAgents: [] } : null;

    case 'peers':
      return spec.a2a.peers.length > 0
        ? { ...spec, a2a: { ...spec.a2a, peers: [] } }
        : null;

    case 'model_cache':
      return spec.cache.modelResponses
        ? { ...spec, cache: { ...spec.cache, modelResponses: false } }
        : null;

    case 'none':
      return null;
  }
}
