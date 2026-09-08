# 02 · `relay-agent-builder` — the conversational agent

**Service:** `relay-agent-builder` (Python, FastAPI + LangGraph, ~9.9k LOC).
**Class:** §1.1 #2, long-running conversational · **Lifetime:** registered (§18.1) · **Durability:** strict · **Transport:** SSE.

## What it does today

A merchant describes a workflow in natural language; the service builds it. Six agents run as a
pipeline — `intent` → `trigger` → `topology` → `schema_grounding` → `dsl_drafting` → `correction` —
producing Relay DSL, which it writes back to Relay. A session survives many turns and many runs, and
the service learns from every outcome.

It is the memory-heavy case. Eight Postgres tables, `pgvector` with a JSON fallback
(`SafeVector`), redaction before every cross-merchant write.

## The six agents are sub-agents, not peers

§13.3's rule is that **the ownership boundary is the protocol boundary.** All six agents are owned
by one team, deploy together, and share the caller's context. A network hop between `topology` and
`schema_grounding` would be a §13.3 violation in the other direction — "if a network hop separates a
planner from its own summarizer, it should have been a sub-agent."

So: **one registered agent, six sub-agents, one namespace.** The schema enforces this structurally
— `agent_version_sub_agents` FKs on the composite `(id, namespace_id)` of both the parent version and
the child agent, so a cross-namespace sub-agent is unrepresentable, not merely rejected.

```yaml
metadata: { name: workflow-builder, namespace: relay-builder }
spec:
  subAgents: [intent, trigger, topology, schema-grounding, dsl-drafting, correction]
  memory:
    enabled: true
    tiers: [working, conversational, semantic, episodic, procedural, external]
    scope: { semantic: org, episodic: tenant, procedural: org }
```

Note `semantic: org` and `procedural: org` — deliberate, and the source of this consumer's one
real conflict with the spec. See **Cross-tenant memory** below.

## Integration sequence

```
Browser (builder UI)
   │  POST /v1/threads                          once per build session
   │  POST /v1/threads/{id}/runs                each turn — a plain POST, per §12.1
   │  GET  /v1/threads/{id}/events   ── SSE ──▶  live pipeline progress
   ▼
relay-agent-builder  (thin: auth, merchant resolution, DSL assembly, Relay write-back)
   │
   ▼
Agent Platform ── run ── sub-agent delegation ×6 ── interactions ── memory
```

| Step | Route | Replaces |
|---|---|---|
| 1 | `POST /v1/threads` | a `pipeline_sessions` row |
| 2 | `POST /v1/threads/{id}/runs` | `POST /chat`, `POST /build`, `POST /correct` |
| 3 | `GET /v1/threads/{id}/events` | `/chat/stream`, `/build/stream`, `/correct/stream` |
| 4 | `GET /v1/threads/{id}/messages` | the `transcript` column — and now §6.3-correct: what the user *received* |
| 5 | `GET /v1/runs/{id}/usage` | `GET /sessions/{id}/usage` |
| 6 | `GET /v1/runs/{id}/events/history` | `GET /sessions/{id}/events` — replay of a past run |
| 7 | `GET /v1/interactions` · `POST /v1/interactions/{id}/respond` | the lesson approval queue |

## Its memory tables map almost 1:1 onto §6.1

| Today | §6.1 tier | Platform home | Note |
|---|---|---|---|
| `pipeline_sessions` | conversational / working | `threads` + conversational memory | `stage` becomes thread metadata; `state_json` becomes run input/output |
| `agent_events` (`session_id`, `run_id`, `node`, `seq`, `event_type`, `payload`) | — | **`events`** | **Already the right shape.** Per-run `seq` ordering is exactly what §12.1's `Last-Event-ID` and §13.4's stream guarantee need. What it lacks is `schema_version` (§0.2) and a delegation chain |
| `episodic_memory` | episodic | `memory_records` tier `episodic` | prompt embedding + `success` + `repair_attempts` → `structured` + `salience` |
| `memory_lessons` (`status: REQUESTED\|APPROVED\|REJECTED`, `reviewed_by`) | procedural | `memory_records` tier `procedural` **+ `interactions`** | The approval half becomes a first-class Interaction (§14). See below |
| `knowledge_entries` (3 kinds, `use/success/fail_count`) | semantic | `memory_records` tier `semantic` | Ranking signal moves to `salience` + `access_count` |
| `action_output_schemas` (PII-stripped, `piece_version`-keyed) | semantic | `memory_records` tier `semantic` | A `piece_version` bump as a deliberate cache miss is good design — keep it as part of the memory key |
| `workflow_snapshots` (DSL JSON) | — | **`artifacts`** (§11.2) | Currently JSON in Postgres. Becomes content-addressed object storage — §20, "no large binary content in Postgres" |
| `llm_cache` (`prompt_hash → response_text`) | — | **model response cache** (§10) | Platform-managed, and only where the agent declares determinism acceptable. **Never in the replay path** |

`llm_cache` is worth a beat: today a cache hit and a cache miss produce *different* stored history,
because the cache sits inside the agent. §10's hard rule is the opposite — replay reads recorded
outputs from events, never from cache, so a hit and a miss must produce identical replayable
history. Moving this table into the platform cache layer is not a refactor; it is a correctness fix.

## Lesson approval is an Interaction, not a status column

`memory_lessons.status` cycling `REQUESTED → APPROVED | REJECTED` with `reviewed_by` and
`reviewed_at` is §14 rebuilt inside the consumer. Under the platform:

```
run proposes a lesson
   → Interaction { kind: 'approval', required_authorization: {...}, expires_at }
   → run status 'waiting'
   → reviewer answers via POST /v1/interactions/{id}/respond
   → run resumes; memory_record written with provenance 'consolidated'
```

Two things the consumer gets for free that it does not have today: **an expired interaction is a
defined run outcome, not a hang** (§14.2), and the approval is audited against a principal rather
than a free-text `reviewed_by` string.

## Cross-tenant memory — the one real conflict

`knowledge_entries` and `action_output_schemas` are **deliberately cross-merchant**. Payloads are
PII-stripped on write (`memory.redact`) precisely so one merchant's successful build teaches the
next merchant's. That shared corpus is the product's compounding asset — remove it and the service
stops improving.

§6.2 scopes memory `Org → Tenant → User → Agent → Thread → Run` with explicit sharing rules, and
§5.2 makes tenant isolation structural. The current `memory_records` design has `scope = 'org'` with
`tenant_ref` still on the row — which lets the row exist but does not express *"this row was
derived from tenant A's data and is intentionally readable by tenant B, because it was redacted."*

Three ways out, in order of preference:

1. **Add a redaction-policy reference to org-scoped memory.** A row at `scope: org` carries
   `redaction_policy_id` and lineage back to its tenant-scoped source; retrieval at org scope is
   permitted only for rows with a satisfied policy. Keeps §15.3 lineage intact, makes the sharing
   *auditable* rather than implicit.
2. **A distinct `shared` scope above `org`** with its own admission path. Cleaner conceptually,
   but adds an enum value to a Phase-1 table.
3. **Two stores** — tenant-scoped memory in the platform, the shared corpus staying in
   relay-agent-builder. Loses lineage and duplicates retrieval, but requires no platform change.

**Recommendation: (1).** It is the only option where §15.3 can still answer "where did this claim
come from" across the tenant boundary, and that question is exactly what a redacted cross-merchant
store makes hard. This needs a decision before Phase 2 — it is listed in the open questions.

## Effect contracts

```yaml
tools:
  - ref: relay.catalog.pieces.list
    effects: [readOnly, cacheable]
    cache: { ttl: 300s, scope: org }

  - ref: relay.knowledge.search
    effects: [readOnly, cacheable]
    cache: { ttl: 60s, scope: org }

  - ref: relay.workflow.create
    effects: [essential, idempotent]
    idempotencyKey: "${runId}:${sessionId}"

  - ref: relay.workflow.update
    effects: [essential, idempotent]
    idempotencyKey: "${runId}:${workflowId}:${revision}"

  - ref: relay.workflow.activate
    effects: [essential, idempotent, humanApprovalRequired]
    # activation puts a merchant's workflow live — the approval gate is the point
```

**No MCP.** `trigger_tools.py` says so explicitly: "No MCP layer — direct HTTP tools." These become
registered HTTP-origin tools (`tools.origin = 'http'`). That is a legitimate choice, not a gap —
§8.1 treats all origins identically while preserving protocol metadata, so nothing is lost by
staying on HTTP against a first-party service.

## Business state stays in Relay

§3.1 is load-bearing here. The workflow DSL is a **Relay** entity. The platform holds each drafted
DSL as an artifact — a proposal and an audit trail — and relay-agent-builder commits it to Relay
through `relay.workflow.update`. The platform must never become the system of record for a
merchant's workflow, and `workflow_snapshots` moving to `artifacts` is what keeps that true: an
artifact is explicitly *not* canonical.

## Failure behaviour, before and after

| Failure | Today | After |
|---|---|---|
| Process restart mid-build | Session row survives; the in-flight LangGraph run does not. User re-drives from the last stage | Run resumes from its last checkpoint; the thread never noticed |
| A sub-agent fails | Fails the pipeline | Fails the parent — correct, and what §13.3 specifies for sub-agents |
| Reviewer never answers a lesson | Row sits `REQUESTED` forever | Interaction expires; expiry is a defined run outcome (§14.2) |
| Model non-determinism breaks replay | `llm_cache` makes replay differ from the original run | Replay reads events, never cache (§10) |

## Migration delta

**Deletes:** `agent_events`, `llm_cache`, `pipeline_sessions`, the streaming services, the
lesson-approval status machine, `tool_cache.py`.
**Keeps:** the six agent prompts and the LangGraph topology (framework layer, §2.1); DSL assembly,
validation, repair and template rescue — all domain logic; Relay write-back.
**Gains:** durable runs, replay, SSE resume, expiry semantics on approvals, cost per merchant.
**Blocked on:** the cross-tenant memory decision. Migrating `knowledge_entries` before that is
settled would either break the shared corpus or quietly violate §5.2.

## Open questions

1. **Cross-tenant memory** (above). Blocks Phase 2 for this consumer. Recommendation: redaction-policy
   reference on org-scoped memory, with lineage preserved.
2. **Six sub-agents in one run, or six runs on one thread?** Sub-agents share the caller's context and
   fail the parent; six runs would give per-stage retry and independent checkpoints at the cost of
   context re-assembly per stage. The current pipeline behaves like the former; the `stage` column
   suggests the author wanted the latter.
3. **Does `agent_events.node` survive as a platform concept?** It names a LangGraph node — framework
   vocabulary, which §0.3 keeps out of the persisted model. It probably belongs in
   `events.protocol_metadata`, not a core column.
