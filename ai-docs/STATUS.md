# What the platform can serve today

Measured against §1.1's seven workload classes and the three consumers in
`client-interactions/`. Every "yes" below has a test behind it; every "no" is a real gap,
not a rough edge.

## Workload classes (§1.1)

| # | Class | Status | What is missing |
|---|---|---|---|
| 1 | Autonomous tool-using agents | **Yes** | — |
| 2 | Long-running conversational | **Yes** | — |
| 3 | Coding agents & SWE workflows | **Partly** | Artifacts, plan approval, sub-agents and MCP land, and the container's isolation flags are real. But the sandbox entrypoint is `sh -c cat` — it never executes tool logic — so no code has actually run in it |
| 4 | Multi-step workflows, background agents | **Yes** | — |
| 5 | Human-in-the-loop | **Yes** | Routing an interaction to a channel (Slack, dashboard) is the consuming service's job |
| 6 | Voice agents | **No** | The whole media plane (§12.2/§12.3). Phase 5 |
| 7 | Stateful agents, hours→weeks | **Yes** | Durable, resumable, scheduled, remembers, and offloads large step output to artifacts (§7) |

## Consumers

| | Status |
|---|---|
| **01 · ap-executor (ephemeral)** | **Servable.** Inline specs, sync/async, webhook callback, effect contracts, cost per merchant, MCP tools with hash pinning, and a step-driven agent adapter with native tool calling |
| **02 · relay-agent-builder (conversational)** | **Servable.** Threads, turns, transcript, approvals, SSE resume, six memory tiers, artifacts for workflow drafts, and its six-stage pipeline as sub-agents. Cross-tenant sharing is now opt-in per namespace, decided by the consuming service, plus a skills registry and knowledge collections for the shared corpus |
| **03 · coding agent** | **Not yet.** Artifacts, plan approval, sub-agents and MCP land, and the container's isolation envelope is correctly configured. But nothing executes inside it: the entrypoint is `sh -c cat`, which echoes the payload back. Needs a real executor, a purpose-built image, and per-profile egress rules |

## Built and verified

Artifacts with content-addressed dedup, version chains, legal hold and GC · sub-agent
delegation with depth and cycle limits · a step-driven agent adapter · native tool calling
across three providers · MCP client with definition-hash pinning and tenant-scoped
approval, over both streamable-HTTP and stdio · sandbox routing by declared profile ·
Memory engine with six swappable seams (store, vector index, embedder, cache, relation
graph, summariser) · six tiers and scopes · provenance-derived trust · consolidation with
lineage · TTL decay · opt-in cross-tenant sharing, per namespace and per tier ·
Eval harness with six deterministic graders plus a residency-refusing LLM judge · the
§0.5 A/B (same suite, mechanism on vs off, off-arm materialised as a real admitted
version) · a verdict that returns `inconclusive` rather than overclaiming · §15.5
promotion gates that refuse, with audited overrides, canary, shadow and history-derived
rollback · the §0.5 mechanism ledger ·
A2A with local and remote bindings behind one transport seam and a conformance suite run
against both · generated + signed agent cards · an inbound JSON-RPC surface whose task
state is a projection over the existing event log ·
Skills registry with immutable versions, version pinning and capability intersection ·
knowledge collections with idempotent ingestion, deterministic chunking and
retrieval-without-an-agent ·
§7 context engine — eviction then compaction, per-agent disableable, reports what it dropped ·
model response cache · multi-hop interactions ·
Durable runs with lease fencing (epoch asserted on every durable write), a retry cap that dead-letters poison runs the worker never survived to report, bounded `FOR UPDATE SKIP LOCKED` reclaim, batched heartbeats and jittered backoff · per-run total event ordering · checkpoints and resume ·
SSE with `Last-Event-ID` · admission with collected rejections · capability grants ·
model gateway with four providers, fallback and residency enforcement · credential broker ·
effect contracts incl. the non-idempotent recovery rule · HITL approve/deny/resume ·
threads and multi-turn conversation · registered agents with immutable versions ·
webhook and cron triggers · transactional outbox delivery · dead letters ·
API interceptors (timing, backpressure, idempotency) · upcasters with a replay-corpus CI
gate · Prometheus metrics · self-hosted trace and analytics console at `/ui` ·
keyset-paginated run listing · every run subresource (steps, tool invocations with their
authorization, checkpoints, interactions, artifacts, children across both delegation
kinds, recursive tree cost, lineage) · checkpoint fork that refuses to silently repeat an
unreplayable side effect · operator resume that refuses to step past a pending approval ·
agent versions, admission dry-run, §17.7 status conditions, archive-not-delete ·
memory listing by scope and metadata amendment that refuses in-place content edits.

## Not built

| Subsystem | Phase | Consequence |
|---|---|---|
| Prompt and policy registries (§17.2, §17.3) | 3 | Prompts live inline on the spec |
| Eval variance handling | 4 | Each case runs once; a non-deterministic agent's re-run is indistinguishable from a regression |
| Shadow traffic routing | 4 | `shadow_from_version_id` is recorded but nothing routes traffic to it |
| Self-hosted judge model | 3 | `llm_judge` correctly refuses external models (§16.1), so it is unusable until one is registered |
| Agent catalog (§17.6) | 3 | No discovery surface across namespaces |
| Budget enforcement (§5.2) | 3 | Cost is metered per run, not capped per tenant |
| OTLP trace export | 3 | Traces are queryable here but not exportable to a collector |
| `POST /v1/replay` | 3 | Replay is exercised in CI, not offered as an endpoint |
| Row-level security | 4 | Tenant columns exist; enforcement is still application-level |
| Multi-region and DR | 5 | Single region |
| Sandbox executes no tool logic | 3 | The container isolation envelope is real (`--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, non-root, pids/mem/cpu caps) but the entrypoint is `sh -c cat`: it echoes its payload. Nothing runs the tool inside it |
| Purpose-built sandbox image | 3 | Defaults to `alpine:3.20`, unpinned by digest and with no toolchain — unusable for a coding agent |
| Per-profile egress allowlist | 3 | `SANDBOX_NETWORK` is one global env var, so every profile shares one network policy |
| Voice (§12.3) | 5 | Class 6 entirely |

## Decisions still open

1. **Sandbox technology** (Appendix A #4) — blocks class 3 hardening.
2. **Capability grant granularity** (Appendix A #6) — service identity or namespace.
   Phase 1 resolves at the namespace level and records which rule was applied.
