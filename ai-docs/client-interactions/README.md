# Client interactions

How consuming microservices talk to the agent platform. One doc per consumer.
Routes come from `../api-spec.md`; entities from `../../db/schema.sql`; § refs from `../pwd.md`.

| Doc | Service | §1.1 class | Lifetime (§18.1) | Durability (§4.3) | Transport |
|---|---|---|---|---|---|
| [01](./01-ap-executor-ephemeral.md) | `ap-executor` — `ai-agent` node | 1 · autonomous tool-using | **Ephemeral** | strict | sync response / webhook callback |
| [02](./02-relay-agent-builder.md) | `relay-agent-builder` | 2 · long-running conversational | **Registered** | strict | SSE |
| [03](./03-coding-agent.md) | coding agent (open-swe archetype) | 3 · coding & SWE, 7 · hours→weeks | **Registered** | strict | SSE + webhook |

These three were chosen because they bracket the design rather than sample it. If one
set of abstractions serves all three, §0.3's claim that the persisted model is
framework-neutral survives contact with real consumers.

## What each one stresses

| | 01 ephemeral | 02 conversational | 03 coding |
|---|---|---|---|
| Registration | none — inline spec per call | one agent, six sub-agents | one agent, three sub-agents |
| Memory tiers used | none beyond the run | all six | procedural · episodic · external |
| Run duration | seconds | minutes, across many runs on one thread | hours to days |
| MCP | yes, per-call server map | no (direct HTTP tools) | yes, for repo/issue context |
| HITL | no | yes — lesson approval | yes — plan approval, merge gate |
| Sandbox pressure (§0.4) | low — deny-list is enough today | low | **high** — this is the case that picks the isolation technology |
| Human authorising the run | often nobody (scheduled) | the builder in the browser | the engineer who filed the issue |
| Hardest constraint | §18.5 spec-hash cardinality | §6.2 cross-tenant memory | §4.2 survive a worker redeploy mid-run |

## The one contract all three share

Every consumer, regardless of shape, does these four things and nothing else is negotiable:

1. **Passes `tenantRef` on every execution call** (§5.2). Not metadata — a first-class parameter
   that partitions memory, subdivides quota, and gates residency.
2. **Passes a delegation chain that terminates in a human or an explicit "none"** (§0.1). A
   scheduled run with no human present must say so; it may not omit the field.
3. **Declares an effect contract for every tool it registers** (§8.3). This is what makes retry,
   caching and approval-gating safe, and it is a Phase-1 requirement precisely because adding it
   later is a migration across every tool.
4. **Keeps its own business state** (§3.1). The platform holds agent-produced business data as an
   artifact — a proposal and an audit trail — and the consuming service commits it to its own
   canonical store. Two systems claiming authority over a workflow, a PR, or a merchant record is
   the failure this rule exists to prevent.

## Reading order

01 first — it is the smallest complete integration and the one that has to work on day one for
§0.6's "under one day to first working agent" target to mean anything. 03 last — it is the only one
whose requirements can change the substrate (sandbox technology, checkpoint granularity for
multi-hour runs).
