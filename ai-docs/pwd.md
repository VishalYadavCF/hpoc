# General Agent Platform — Architecture & Engineering Specification

**v3 — consolidated**

> A durable agent runtime and control plane for operating stateful, observable, long-lived AI
> agents across many teams and microservices.
>
> **Applications define agents declaratively. The platform provides the durable runtime,
> memory, context management, interoperability, security, and observability required to
> operate them reliably at organizational scale — while remaining ignorant of whether the
> underlying business problem is payments, workflows, loans, coding, or support.**

**Stack:** TypeScript / NestJS · LangChain Deep Agents · PostgreSQL · object storage ·
internal infrastructure only.

---

# §0. Evolution constraints

**These precede and constrain every requirement that follows, including the right to cut
requirements.** They exist because the dominant risk is not choosing the wrong feature set —
it is building something that cannot change, or that never ships. Each item is here because it
is **impossible or ruinously expensive to retrofit**.

## 0.1 Agent identity and delegated authority are first-class

Every agent has a workload identity distinct from the human, the tenant, and the calling
service. Every action records the full delegation chain and the originating human
authorization. On-behalf-of semantics propagate across agent hops and into external credential
minting (§16.3).

- No shared service credentials. No ambient authority.
- The system must always answer: *which human authorized this side effect, through which chain
  of agents, exercising whose permissions?*

Retrofitting touches every call path, audit record, and token mint, and it is the first
question any security review asks.

## 0.2 Every persisted event carries a schema version

Replay, time-travel debugging, checkpoint forking, and run reconstruction all rest on the event
log remaining readable. The first unversioned schema change silently renders prior history
unreplayable, discovered when history is most needed.

- Versioned event schemas. **Upcasters** lift historical events to current shape at read time.
- CI replays an archived corpus of real event logs on every change to the event model.
- A change that breaks replay of existing logs **is a breaking change**.

Event-sourced systems die of this specifically.

## 0.3 The persisted model is framework- and protocol-neutral

No orchestration-framework concept (planning tools, sub-agent semantics, virtual filesystems)
and no wire-protocol concept (MCP message shapes, A2A task objects) appears in the event
schema, database tables, or public API. The persisted model describes Agents, Threads, Runs,
Steps, Tool Invocations, Memory, Checkpoints, Artifacts, and Interactions in neutral terms.
Frameworks and protocols are **adapters that translate into it**.

**Validation:** maintain a second orchestration adapter, however minimal, from the first
release. If writing it is hard, the abstraction has already leaked.

## 0.4 Tool execution is sandboxed uniformly

One isolation boundary for **all** agent types, chosen and implemented before the first tool
executes. Not a coding-agent special case. Decide explicitly: in-process, container, or microVM.

As models grow more capable the blast radius of tool execution grows with them, and security
isolation must be the substrate, not a layer.

## 0.5 Compensating mechanisms are optional and measured

Much of this platform compensates for **current** model limitations:

| Mechanism | Compensates for |
|---|---|
| Memory tiers, compaction, summarization | Finite context window |
| Planning scaffolds | Weak native planning |
| Sub-agent orchestration | Weak long-horizon coherence |

Each becomes dead weight — or actively harmful — if models improve on that axis. Forced
summarization discarding detail the model could have used natively is a net negative, and its
harm is invisible without measurement.

- Each mechanism is **individually disableable per-agent**.
- Each has an **eval demonstrating current benefit**; one that cannot be shown to help is removed.
- The **model registry declares capabilities** (native long context, native tool loops, extended
  thinking, native memory) so agents defer to native capability rather than assuming a lowest
  common denominator.

§15.5 makes this operational by wiring evals into the deployment gate. Without that, this
constraint is aspirational.

## 0.6 Phasing

**This document does not ship as one release.** The gap between specification and first
production deployment is itself the largest obsolescence risk. The subsystem count here is
large; the phasing below is what keeps it from becoming a multi-year prelude to nothing.

| Phase | Subsystems | Consumers unblocked |
|---|---|---|
| **1 — Substrate** | Run engine & state machine · Postgres schema **with tenant columns present** · event schema versioning · worker runtime with leases · SSE transport · tool runtime with **effect contracts** · sandbox · credential broker (minimal) · admission control · identity & delegation chain · OTel tracing · SDK & ephemeral path | A, E |
| **2 — Context & scale** | Memory tiers · context engine · artifact store & lifecycle · **model gateway** · prompt registry · caching (prompt, model, tool) · backpressure · eval harness v1 | C |
| **3 — Integration** | MCP client · **human interaction runtime** · coding workspace · policy registry · lineage | F (with §16 identity work) |
| **4 — Federation** | A2A · **nested tenancy enforcement** · agent catalog · **eval→deployment loop** · canary & shadow rollout | B |
| **5 — Media & resilience** | Voice media plane · voice backpressure · multi-region path · DR | D |

**Three things must be in Phase 1 even though they feel like later concerns**, because they are
contracts rather than features: effect classification (§8.3), tenant columns in the schema
(§5.2), and the delegation chain (§0.1). Adding any of them later is a migration across every
table and every tool.

**Target time-to-first-working-agent: under one day.** Anything that raises it is reconsidered,
including requirements in this document. If standing up an agent here is harder than calling a
model API directly, teams route around the platform.

## 0.7 Kill criteria

Written in advance so the response is considered rather than defensive.

- **Whole-system:** model providers shipping durable agent runtimes with equivalent memory and
  observability is a plausible 12-month development. State what would make adopting one
  preferable to continued investment here.
- **Per-subsystem:** each major subsystem — the memory hierarchy in particular — carries a
  stated condition under which it is removed.

## 0.8 Operability

Operable by people who did not build it. Named on-call ownership from first production
deployment. A stuck run diagnosable at 2am without reading source. Runbooks for §4 failure
modes. Platform-level observability (§15.4) is part of this, not a nice-to-have.

---

# §1. Objective and scope

Provide a reusable execution substrate so teams do not rebuild durability, memory, context
management, checkpointing, tool execution, authorization, MCP, A2A, HITL, artifacts, streaming,
observability, evaluation, or cost controls for every agentic product.

**Application teams own agent behavior and their domain. The platform owns execution
reliability and remains domain-neutral.**

## 1.1 Workload classes

| # | Class | Durability | Transport |
|---|---|---|---|
| 1 | Autonomous tool-using agents | strict | SSE |
| 2 | Long-running conversational agents | strict | SSE |
| 3 | Coding agents & SWE workflows | strict | SSE / webhook |
| 4 | Multi-step workflows, background agents | strict | webhook / poll |
| 5 | Human-in-the-loop agents | strict | SSE + webhook |
| 6 | Voice agents | relaxed | WebRTC / telephony WS |
| 7 | Stateful agents running hours→weeks | strict | webhook / poll |

## 1.2 Design principles

1. **Durability over convenience.**
2. **State is first-class** — persisted intentionally, and cleanly separated (§3.2).
3. **Declarative configuration.**
4. **Provider, framework, and protocol abstraction.**
5. **Observable by default** — including the platform itself.
6. **Internal-only telemetry; policy-gated egress** (§16.1).
7. **Composable primitives.**
8. **Failure-aware** — distributed failure is expected.
9. **Context is a managed resource.**
10. **Honest guarantees** (§4.5).
11. **Domain-neutral** — the platform understands capabilities, authorization, state, and
    execution; never the business model of a consuming service.

---

# §2. Architectural model

## 2.1 The layering boundary

The central question is **which capabilities belong to the platform and which stay in the
layers around it.** The platform's value is that its abstractions survive changes beneath and
beside it.

```
┌──────────────────────────────────────────────────────┐
│  Application            agent behavior, prompts,     │
│                         domain tools, business state │
├──────────────────────────────────────────────────────┤
│  Agent Platform         durability, state machine,   │
│  ← owns the contract    memory, context, checkpoints,│
│                         effects, credentials, HITL,  │
│                         registries, gateway, caching,│
│                         observability, protocols     │
├──────────────────────────────────────────────────────┤
│  Agent Framework        reasoning loop, planning,    │
│  (Deep Agents)          sub-agent spawning           │
├──────────────────────────────────────────────────────┤
│  Providers              models, MCP servers, peers,  │
│                         speech, vector stores        │
├──────────────────────────────────────────────────────┤
│  Infrastructure         Postgres, object store,      │
│                         workers, queues              │
└──────────────────────────────────────────────────────┘
```

**Rule:** anything the platform persists, exposes in its API, or reports in telemetry is a
platform concept. The framework may *produce* it; it may not *define* it. MCP and A2A are
adapters, never the domain model — the core runtime must compile with every protocol adapter
removed.

## 2.2 Subsystem map

```
┌──────────────────────── CONTROL / GOVERNANCE ────────────────────────┐
│ Agent Registry · Agent Versions · Model Registry · Prompt Registry   │
│ Policy Registry · Tool / MCP Registry · Peer Registry · Catalog      │
│ Identity & Credential Broker · Quotas & Budgets · Admission Control  │
│ Deployment & Rollouts · Trigger Registry                             │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ spec + dispatch
┌────────────────────────────────▼─────────────────────────────────────┐
│ EXECUTION PLATFORM                                                    │
│ Durable Run Engine · Worker Runtime · Scheduler & Trigger Dispatcher  │
│ Framework Adapter · Tool Runtime · Model Gateway · Cache Layer        │
│ Memory Engine · Context Engine · Checkpoint Manager · Artifact Manager│
│ Interaction Runtime (HITL) · MCP Adapter · A2A Dispatcher             │
│ Streaming · Voice Media Adapter                                       │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────┐
│ STATE / DATA        PostgreSQL · Object Store · Vector Layer          │
│                     Event Log                                         │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────┐
│ QUALITY / OBSERVABILITY                                               │
│ OpenTelemetry · Traces · Events · Metrics · Replay · Lineage          │
│ Evaluations · Feedback · Cost & Usage · Platform Self-Observability   │
└──────────────────────────────────────────────────────────────────────┘
```

## 2.3 Control plane vs data plane

Workers scale and fail independently of the API layer. A control-plane deploy must not
interrupt in-flight runs. This separation is what makes §4.2's recovery guarantees possible.

---

# §3. Domain model

```
Agent ──< AgentVersion ──< Run
  │                          │
  └──< Thread ──────────────<┘──< Step ──< ToolInvocation
                             │      │
                             │      └──< Event ──> Trace/Span
                             ├──< Checkpoint
                             ├──< Artifact
                             └──< Interaction        (HITL, §14)

Memory ──> scoped Org │ Tenant │ User │ Agent │ Thread │ Run
```

| Entity | Definition |
|---|---|
| **Agent** | Durable identity + capability metadata. Stable across versions. |
| **AgentVersion** | Immutable materialized spec. Runs bind to a version, not an agent. May be anonymous (§18.1). |
| **Thread** | Logical continuity of an interaction. Long-lived; spans many runs. |
| **Run** | One execution attempt. The unit of durability, delegation, and cost. |
| **Step** | One durable increment: model call, tool call, memory op, or delegation. |
| **ToolInvocation** | One tool execution with inputs, outputs, timing, effect class, authorization. |
| **Checkpoint** | Resumable state snapshot at a step boundary. |
| **Interaction** | A durable request for human input, independent of channel (§14). |
| **Memory** | Typed, scoped, retrievable knowledge (§6). |
| **Artifact** | Large content held outside Postgres, with lifecycle (§11.2). |
| **Event** | Append-only, versioned fact. The system of record. |

**The thread/run distinction is load-bearing.** Workspace, artifacts, and memory persist on the
thread; execution state, retries, and checkpoints live on the run.

## 3.1 Three kinds of state — never conflated

| Runtime state | Agent memory | Business state |
|---|---|---|
| Execution cursor | Facts, preferences | Merchant, payment |
| Checkpoint | Experiences | Workflow, loan |
| Pending operations | Procedures | Invoice, PR, dispute |
| Retry state | Conversation history | |
| Worker ownership | | |
| **Owner: platform** | **Owner: platform** | **Owner: consuming service** |

**The platform must never become the system of record for business state.** Where an agent
produces business data, the platform holds it as an artifact — a proposal and audit trail — and
the consuming service commits it to its own canonical store. Two systems claiming authority
over the same entity is the failure this rule prevents.

---

# §4. Durable execution

## 4.1 Run state machine

```
                    ┌─────────┐
                    │ queued  │
                    └────┬────┘
                         ▼
    ┌──────────────► running ◄──────────────┐
    │               ┌──┴──┬──────────┐      │
    │               ▼     ▼          ▼      │
    │       tool_execution │    checkpointed│
    │               │      │          │     │
    │               └──────┤          └─────┘
    │                      ▼
    │                   waiting          (Interaction · peer delegation
    └──────── resumed ◄────┘             · external event · trigger)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   completed          failed          cancelled
                         │
                         ▼
                   dead_letter
```

Every transition is a persisted, versioned event. `waiting` is the single suspension state
covering human interaction, peer delegation, MCP server-initiated requests, and external waits —
one mechanism, four callers.

## 4.2 Recoverability

Recoverable when the process crashes, the container restarts, the worker is redeployed, a tool
call fails, an LLM request times out, or infrastructure is briefly unavailable.

Checkpointing at step boundaries; event-sourced history enabling replay, time-travel debugging,
and forking; partial-progress persistence; multiple attempts with history retained.

Checkpoint design must address frequency, granularity, atomicity, versioning, state migration,
replay, branching, rollback.

## 4.3 Durability tiers

A synchronous checkpoint inside a sub-second conversational turn is fatal to voice.

**`strict`** — synchronous durable checkpoint at every step boundary. Default.
**`relaxed`** — asynchronous, batched checkpoints with a bounded loss window. Voice and other
latency-critical paths.

**The tier governs conversational and reasoning state only.** Tool invocations follow their
effect contract (§8.3) independently, so a `relaxed` voice run still writes a payment link
synchronously. Specify precisely what is lost on crash at the relaxed tier and how a resumed
thread reconciles a partially-recorded turn.

## 4.4 Distributed execution primitives

At-least-once execution · idempotency keys · retries with exponential backoff · timeouts ·
cancellation · **leases** · **heartbeats** · **worker failure detection and lease reclamation** ·
optimistic and pessimistic concurrency control · transactional state transitions · dead-letter
handling.

Queue via Postgres `SELECT … FOR UPDATE SKIP LOCKED` with lease expiry, so a worker dying
mid-step returns its run to the queue rather than stranding it.

## 4.5 Honest guarantees

- **Execution delivery: at-least-once.** A step may be attempted more than once.
- **Side effects: effectively-once via idempotency**, not exactly-once — achieved with
  idempotency keys plus a transactional outbox, and only for tools declaring support (§8.3).
- **Non-idempotent tools cannot be made exactly-once.** They are declared as such and routed
  through at-most-once handling or human approval rather than pretended about.
- **Event ordering: total per-run**, not global.

## 4.6 Run-graph rules

**Never hold a thread lock across a delegation.** Per-thread serialization plus a synchronous
peer call is a deadlock: A holds the lock, calls B, B calls back into A's thread. Release before
dispatch, re-acquire on continuation. Without this, the first cross-team integration hangs
production.

**Child runs survive parent crashes.** On resume the parent resubscribes to outstanding children
by ID and replays missed events. Specify how a resumed parent reconciles children that completed
while it was down.

**Cycle detection and depth limits** enforced by the engine, not by convention.

---

# §5. Resource governance and backpressure

Quotas alone are insufficient. A quota rejects; backpressure shapes.

## 5.1 Enforcement levels

Backpressure applies independently at: **Organization · Namespace · Tenant · Agent · Worker
pool · Model · Tool · MCP server · A2A peer · Speech provider.**

```
10,000 voice calls requested
        ↓
   capacity = 500
        ↓
 queue │ throttle │ shed load    ← explicit policy per level
```

Every level declares its response to saturation: queue with a bound, throttle to a rate, or
shed with a typed error the caller can act on. Silent queueing without a bound is how a burst
becomes an outage.

Downstream limits are first-class: an MCP server rated at 20 QPS is throttled by the runtime,
not discovered through errors. Speech provider concurrency ceilings (§12.3) are treated the same
way.

## 5.2 Tenancy hierarchy

**Org → Namespace (service) → Tenant → User.**

The Tenant level exists because consuming services have their own customers — merchants,
lenders, end clients — whose data must be structurally isolated from one another. `tenantRef` is
a first-class run parameter, not application metadata, and participates in:

- memory partitioning (§6.2)
- quota, backpressure, and budget subdivision
- cost attribution and billing data
- trace and replay access control
- data-residency evaluation

**Tenant columns land in Phase 1 even though enforcement lands in Phase 4.** Adding the level
later is a migration across memory, quota, event, and trace tables.

---

# §6. Memory architecture

A first-class subsystem, not a chat-history table. Subject to §0.5 — every tier is disableable
and measured.

## 6.1 Tiers

| Tier | Contents |
|---|---|
| Working / short-term | In-context buffer for the current execution |
| Conversational | Message and interaction history for a thread |
| Semantic / long-term | Facts, preferences, entities, knowledge |
| Episodic | Timestamped prior interactions and run outcomes |
| Procedural | Workflows, strategies, reusable procedures |
| External / offloaded | Documents, files, codebases, large outputs, transcripts |

## 6.2 Interface and scoping

Store · retrieve · update · delete · rank/relevance-retrieve · summarize · consolidate ·
lifecycle.

Scope: **Org → Tenant → User → Agent → Thread → Run**, with explicit sharing rules and TTL /
retention per scope. Background consolidation — summarization, re-ranking, decay, merging,
re-embedding — runs asynchronously outside the request path.

## 6.3 Transcript fidelity

**Memory records what the user actually received, never what the model merely generated.** This
is the barge-in rule (§12.3) stated as a memory invariant; violating it corrupts episodic memory
in a way that surfaces later as the agent referencing things never said aloud. For regulated
voice workloads it is also a compliance requirement.

## 6.4 Provenance

Every memory record carries provenance and remains distinguishable from first-party knowledge at
retrieval time. Peer artifacts and final messages may be admitted; peer internal reasoning and
unverified assertions may not be promoted into semantic memory. External tool output is tagged
and treated as untrusted. See §15.3 for full lineage.

---

# §7. Context engine

The runtime maintains a **logical context substantially larger than the model's physical
window**.

```
                 Agent Logical Context
                         │
        ┌────────────────┼────────────────┐
   Active Context    Memory Store    Artifact Store
        │                │                │
   Model Window     Long-term data    Files / Outputs
        └──────── Context Retrieval ──────┘
```

Compaction · rolling and hierarchical summaries · relevance retrieval · prioritization ·
eviction · artifact offloading · retrieval-on-demand · tool-result compression · persistent
working memory.

Requires a defined **memory-pressure trigger** and explicit **eviction priority policy**.

Draw on Letta-style virtual context management as reference without coupling to it. **Every
mechanism here is disableable per §0.5** — this is the subsystem most likely to be obsoleted by
model improvements and the one where silent harm is hardest to detect.

---

# §8. Tool layer and effect contracts

## 8.1 Normalized abstraction

```
Agent Tool Registry
       ├── Native Tool
       ├── HTTP Tool
       ├── Function Tool
       └── MCP Tool ──> MCP Server
```

The engine treats all origins identically — same invocation record, same durability, same
authorization, same telemetry — while **preserving protocol metadata** so observability
distinguishes native / MCP / HTTP / internal-service calls and attributes latency and failure
correctly.

Registry: registration · schemas · versioning · permissions · authorization · timeouts · retries ·
invocation tracking · result persistence · error handling · cancellation · metadata.

All tool execution runs inside the uniform sandbox of §0.4.

## 8.2 Four distinguishable concerns

Planning/reasoning state · model invocations · tool execution · **external side effects**. These
have different replay and durability semantics and must not be collapsed.

## 8.3 Effect classification

Every tool declares its effect contract. This is what makes §4.5's guarantees honest and §10's
caching safe.

| Class | Meaning | Runtime behavior |
|---|---|---|
| `readOnly` | No state change | Freely retryable; cacheable if declared |
| `idempotent` | Repeat is safe | Retried with idempotency key |
| `nonIdempotent` | Repeat is unsafe | At-most-once; no blind retry |
| `transactional` | Participates in a transaction | Outbox; two-phase where supported |
| `compensatable` | Reversible by a named inverse | Compensation registered for rollback |
| `essential` | Must not be lost | **Synchronous durable write regardless of tier** |
| `humanApprovalRequired` | Gated | Creates an Interaction (§14) before executing |
| `cacheable` | Result reusable | Cache key + TTL declared |

```yaml
tools:
  - ref: transactions.search
    effects: [readOnly, cacheable]
    cache: { ttl: 60s, scope: tenant }

  - ref: payment.link.send
    effects: [essential, idempotent]
    idempotencyKey: "${runId}:${invoiceId}"

  - ref: refund.initiate
    effects: [essential, nonIdempotent, humanApprovalRequired, compensatable]
    compensation: refund.reverse
```

`essential` is what lets a `relaxed`-tier voice run hold strict guarantees on the handful of
steps that move money, paying the latency cost only where it matters.

**Never cache side-effecting operations.** The classification makes this enforceable rather than
a convention.

---

# §9. Model gateway

Every microservice must not reimplement model routing. The gateway is the single path from agent
to provider.

```
Agent → Model Gateway → ┌ Routing ┐
                        │ Fallback & failover
                        │ Timeouts & retries
                        │ Rate limiting
                        │ Token & cost accounting
                        │ Provider health
                        │ Residency / egress policy
                        │ Capability matching
                        └ Config normalization
                              ↓
                        Provider adapters
```

Responsibilities:

- **Routing** by model ref, with capability matching against §0.5 declarations.
- **Fallback and failover** on provider error, with the fallback recorded in the event log —
  a run that silently switched models must be diagnosable.
- **Rate limiting and backpressure** per §5.1's model level.
- **Token and cost accounting** attributed to org / namespace / tenant / agent / run.
- **Residency and egress policy** evaluated per call against the agent's data class (§16.1).
  This is the enforcement point for Constraint 2 — an agent marked `regulated` cannot reach an
  external provider even if its spec names one.
- **Configuration normalization** across provider dialects.

The gateway is a control point, not a proxy for convenience. It exists so residency, cost, and
capability policy have exactly one place to live.

---

# §10. Caching

Platform-managed where semantically safe, driven by declared contracts rather than heuristics.

| Cache | Key scope | Notes |
|---|---|---|
| Prompt cache | Provider-native | Registered agents benefit; ephemeral specs churn keys (§18.5) |
| Model response | Model + prompt + params | Only where the agent declares determinism is acceptable |
| Tool result | Per `cacheable` contract (§8.3) | TTL and scope declared per tool |
| MCP discovery | Server identity + protocol revision | Honors server-supplied cache directives |
| Memory retrieval | Query + scope | Invalidated on write to that scope |
| Artifact metadata | Artifact ID | Content-addressed; immutable |

**Two hard rules.**

**Caches are never part of the event log.** Replay reads recorded outputs from events, never
from cache. A cache hit and a cache miss must produce identical replayable history, or §0.2's
guarantee is void.

**Cacheability is declared, never inferred.** Anything not classified `readOnly` or `cacheable`
(§8.3) is uncached. Side-effecting operations are never cached.

---

# §11. Storage architecture

## 11.1 PostgreSQL — primary durable store

Agent definitions and versions · threads · runs · steps · tool invocations · checkpoints ·
interactions · events · memory metadata and vectors (`pgvector`) · audit records · queue ·
pub/sub (`LISTEN/NOTIFY`).

Include indexing, partitioning, and retention for high-volume tables (events, steps, tool
invocations), plus the schema-versioning and upcaster design of §0.2.

## 11.2 Object storage and artifact lifecycle

**Large content does not belong in Postgres.** Files, repositories, patches, generated
artifacts, large tool outputs, transcripts, audio, and oversized model outputs live in an object
store behind an **Artifact abstraction**. Postgres holds metadata, content hash, and reference.

Artifacts become foundational for coding workspaces, workflow drafts, documents, transcripts,
audio, reports, and context offloading — so the lifecycle is not optional:

**ownership · versioning · retention · TTL · encryption · deduplication (content-addressed) ·
garbage collection · access control · lineage · legal hold.**

Legal hold and retention matter immediately for regulated consumers — a dispute transcript under
hold must survive TTL expiry.

## 11.3 Vector / retrieval layer

Retrieval stays abstract enough to support alternative stores without embedding one into the
execution engine. `pgvector` is the default, not the contract.

**On the Postgres-centric default:** queue, pub/sub, and vectors in Postgres is a deliberate
simplicity bet worth making at this scale. Artifacts are the explicit carve-out. Any further
datastore requires written justification.

---

# §12. Transports

## 12.1 SSE control plane

**All client-facing streaming uses Server-Sent Events.** WebSockets are excluded from the
browser-facing control plane and permitted only server-to-server (telephony, speech vendors).

SSE is plain HTTP, so existing NestJS guards, interceptors, rate limiters, and OTel HTTP
instrumentation apply unchanged; client→server is a plain POST, the correct shape for chat turns,
approvals, and cancellation; and `Last-Event-ID` provides resumable streams natively.

**This transport serves three consumers** — internal clients, MCP interactions, and A2A
streaming, since both protocols stream over SSE.

Also provide **webhook** and **async job-polling** modes for background and long-horizon
workloads.

**Hard requirements — each silently breaks streaming if missed:**

- **HTTP/2 end-to-end.** HTTP/1.1's ~6-connections-per-origin limit hangs streams once a user
  opens a third tab.
- **Resumable streams.** Monotonic per-run event sequence numbers; on reconnect honor
  `Last-Event-ID` by replaying then tailing. Define the replay retention window.
- **Disable proxy buffering** — `X-Accel-Buffering: no`, `proxy_buffering off`. Do not gzip SSE
  unless flushing per event.
- **Heartbeats** every 15–30s (`: ping`) to survive load-balancer idle timeouts.
- **`LISTEN/NOTIFY` fanout, two constraints:** the ~8 KB payload cap means notifying with an
  event ID and reading the row; and `LISTEN` holds a session, so it **breaks under PgBouncer in
  transaction pooling mode** — the listener needs a dedicated direct connection.
- NestJS's `@Sse()` decorator is insufficient for `Last-Event-ID` replay-then-tail and
  backpressure. Expect to use the raw response object.

**Cost note.** If WebSocket cost motivated this, verify the source. Managed gateways billing per
connection-minute *and* per message are usually the real driver; WebSockets on a load balancer
cost roughly what SSE costs.

## 12.2 Voice media plane

Voice does **not** share a transport with the text path.

**Browser: WebRTC.** Not a latency preference — continuous microphone uplink over plain HTTP is
not portable. Streaming request bodies via `fetch` shipped in Chromium in September 2022 but
remain unimplemented in Firefox, which has blocked baseline availability since; Safari accepts
streams in `Request` objects but will not pass them through `fetch`. WebRTC also provides jitter
buffering, packet-loss concealment, echo cancellation, and adaptive bitrate.

**Telephony: WebSockets, server-to-server.** Non-negotiable; browser constraints do not apply.

Output format is transport-dependent: μ-law 8 kHz for telephony, Opus or PCM for WebRTC.

## 12.3 Voice pipeline

`VAD → STT → agent loop → TTS → transport`

**Clause-boundary chunking into TTS.** Never wait for a complete response. Buffer tokens to the
first sentence or clause boundary, dispatch immediately, continue streaming. Perceived latency is
time-to-first-syllable, and this matters more than model selection.

**Barge-in truncation.** On interruption: cancel the TTS stream, flush the playback buffer, **and
truncate the assistant turn at the audio position actually played**, not generated. Track
playback offset explicitly. State-correctness, not audio cosmetics (§6.3).

**Provider abstraction:** `SpeechSynthesizer` and `Transcriber` ports, routable by language,
region, cost tier, and residency class.

**Capacity:** hosted vendors impose concurrent-session ceilings well below what a shared platform
requires. Enforced through §5.1, not discovered through errors.

**Prior art:** study Pipecat and LiveKit Agents frame pipelines and endpointing before designing
this.

---

# §13. Protocol interoperability

Two axes, deliberately asymmetric. **MCP — outward** (tools outside the system, client-first).
**A2A — lateral** (the inter-agent contract; primary case is two runs on this runtime owned by
different teams).

## 13.1 MCP client

- Support **stdio** and **Streamable HTTP**. **Pin the dated revision**; never track "latest."
- **The current HTTP transport is stateless.** Single POST endpoint; replies as a JSON object or
  a request-scoped SSE stream. The GET stream and protocol-level sessions were **removed** in the
  2026-07-28 revision. **Build no session lifecycle management and no session affinity** — that
  guidance is obsolete. Connection reuse applies only to stdio subprocesses.
- Emit required routing headers (`Mcp-Method`, `Mcp-Name`); header/body disagreement is a client
  bug, not a retry.
- **Cancellation is transport-level** — closing the SSE response stream *is* the signal.
- Honor cache directives (§10), keyed by server identity and revision.
- Server-initiated interactions (sampling, elicitation, list-roots) arrive inside an
  `InputRequiredResult`. Route into the **same `waiting` state** as human interaction.
  **Sampling means an external server can ask us to run a completion** — capability-gated,
  budget-accounted through the gateway, **off by default**.

## 13.2 MCP security

Tool definitions are untrusted text entering the context window, from systems outside our
control. This is the highest-severity surface in the design.

- **Pin tool definitions by content hash.** Any change fails closed and requires re-approval —
  the defense against a server that passes review and mutates afterward.
- **Tenant-scoped server approval.** Bound by one team ≠ available to another.
- **Explicit per-agent tool allowlists.** Never a full server surface by default.
- **All tool output is untrusted input** — a prompt-injection vector. Tag provenance (§15.3).
- **No token passthrough.** The credential broker (§16.3) mints scoped, audience-restricted
  tokens.
- **Validate `Origin`**; bind local servers to loopback.
- Log server identity, definition hash, and resolved permissions per invocation.

**MCP must not bypass the platform's security, observability, durability, or policy layers.**

## 13.3 Sub-agent or peer

| | Sub-agent | A2A peer |
|---|---|---|
| Run identity | Same run | Separate run, own lifecycle |
| Trust domain | Shared | Separate |
| Memory | Shares caller's context | Isolated; artifacts only |
| Versioning | Inline in caller's spec | Independently deployed |
| Failure | Fails the parent | Recoverable error |
| Ownership | Same team | Different team |

**The ownership boundary is the protocol boundary.** If two teams must coordinate a deploy, it
should have been a peer. If a network hop separates a planner from its own summarizer, it should
have been a sub-agent.

**Enforced:** an AgentSpec declares sub-agents only within its own namespace. Cross-namespace
invocation goes over A2A, always.

## 13.4 A2A execution model

A2A interactions are **durable execution entities, not ephemeral HTTP requests.**

| A2A concept | Platform primitive |
|---|---|
| Task | Run |
| `contextId` | Thread |
| Task lifecycle states | Run status (§4.1) |
| `input-required` | `waiting` + Interaction (§14) |
| Status / artifact update events | Projections over the event log |
| Streaming subscription | SSE with `Last-Event-ID` replay |
| Push notifications | Async webhook mode |
| `tenant` | `tenantRef` (§5.2) |

The protocol's requirement that all active streams for a task receive the same events in the same
order, that closing one stream does not affect others, and that task lifecycle is independent of
stream lifecycle is **already satisfied** by an append-only event log with per-run sequence
numbers. **If a second event store appears for A2A, the design has gone wrong.**

**Local and remote bindings.** *Local* (default for same-runtime peers) dispatches directly into
the execution engine as a child run in the same event log — no JSON-RPC, no HTTP round-trip to
self. *Remote* uses JSON-RPC over HTTPS with SSE.

**Conformance:** the bindings must be **semantically identical** — same states, ordering, error
taxonomy, cancellation. Run the suite against both. If an agent behaves differently after moving
out of the runtime, the fast path is a bug, discovered during a migration at the worst moment.
Callers name a peer; the registry resolves the binding.

## 13.5 Delegation safety

Depth limits and cycle detection · **budget propagation** decrementing the *originating*
tenant's ceiling · timeout and cancellation propagation with orphan cleanup · **multi-hop
`input-required`** reaching an actual human up the full chain (§14.3) · **failure containment**
by default, propagation opt-in.

## 13.6 Registries and catalog

**Capability descriptors are generated, not registered.** `exposeAsPeer: true` publishes a signed
Agent Card derived from the spec — the way a Kubernetes Service acquires DNS. No second source of
truth.

The **Agent Catalog** (§17.6) derives from the same AgentSpec. **Do not introduce duplicate
capability-registration systems where metadata can be derived.**

For external peers, **verify the card's signature**; the current version formalizes signed Agent
Cards for domain verification.

---

# §14. Human interaction runtime

HITL is a platform primitive, not an application implementation. The framework may provide
interrupt/resume mechanics; **the platform owns the durable state, authorization, routing,
transport, auditing, and lifecycle of the interaction.**

## 14.1 Interaction as a domain entity

Represented independently of channel, so the same run works whether the human is in Slack, a
merchant dashboard, or a phone call.

```
Interaction
 ├── approval          "may I execute this?"
 ├── question          "which account did you mean?"
 ├── clarification     "your request is ambiguous"
 ├── authentication    "re-authenticate to proceed"
 └── escalation        "transfer to a human operator"
```

## 14.2 Lifecycle

```
Run → waiting → Interaction created → routed to responder
                       ↓
              application renders it
                       ↓
              human responds (authorized)
                       ↓
              Interaction resolved → Run resumes
```

Interactions are durable, have their own timeout and expiry policy, carry an authorization
requirement (who may answer), and are fully audited. An expired interaction is a defined run
outcome, not a hang.

## 14.3 Multi-hop delegation

If peer B needs input, A called B, and a user called A, the interaction propagates **up the full
delegation chain** to whoever can answer, carrying the originating user identity. This does not
fall out of a single-run HITL implementation and must be designed explicitly.

`humanApprovalRequired` in an effect contract (§8.3) creates an Interaction automatically.

---

# §15. Observability, lineage, and evaluation

Fully self-hosted. Prompts, conversations, tool calls, files, generated content, and execution
metadata may contain sensitive company data and **must not reach external telemetry vendors**
(§16.1).

## 15.1 Unified event model

All activity — native, MCP, A2A, gateway, interaction — emits into one taxonomy:

```
agent.started         run.started           tool.called          model.requested
agent.completed       run.checkpointed      tool.completed       model.fallback
                      run.waiting           tool.failed          model.completed
memory.stored         run.resumed
memory.retrieved      run.failed            interaction.created  cache.hit
memory.consolidated                         interaction.resolved cache.miss
                      stream.connected      interaction.expired
artifact.written      stream.resumed
artifact.read                               mcp.tool.called      a2a.task.created
                      approval.requested    mcp.resource.read    a2a.task.progress
                      approval.granted                           a2a.task.completed
```

Every event carries: **schema version** · trace ID · span ID · run ID · thread ID · **parent
run ID** · **causation ID** · **correlation ID** · timestamp · agent identity · **delegation
chain** · tenant ref · protocol metadata.

Causation and correlation IDs are what make a multi-agent execution observable as one distributed
trace rather than a pile of disconnected runs.

## 15.2 Distributed agent execution graph

```
employee_312
     ▼
company-assistant
     ├── MCP ──► confluence
     ├── MCP ──► jira
     └── A2A ──► impl-planner
                     └── MCP ──► confluence
```

Must answer: which agent initiated this · which were delegated work · which tools each invoked ·
which servers were contacted · where latency originated · which execution failed · which model
calls consumed tokens · **which agent caused a downstream failure** · what state existed at each
checkpoint · the complete causal path.

**OpenTelemetry with GenAI semantic conventions.** Propagate **W3C trace context** across every
MCP and A2A hop. Accept inbound context at server endpoints subject to tenant trust policy — do
not blindly adopt trace IDs from untrusted callers.

## 15.3 Lineage

Provenance is traversable, not just tagged. The platform answers **"where did this piece of
information come from?"** end to end:

```
Agent Answer
   ← Memory Record  (consolidated from)
      ← MCP Result  (server, definition hash, timestamp)
      ← Artifact    (content hash, producing run)
      ← Peer Result (peer identity, task ID)
      ← User Input
```

Tracked for user input · model output · memory · tools · MCP · A2A peers · artifacts · consuming
service responses. Compatible with the trust rules of §6.4 — lineage is what makes "this claim is
hearsay from peer X" answerable at retrieval time rather than a policy hope.

## 15.4 Platform self-observability

**Agent observability is not enough.** The platform is itself a distributed system.

Observe: API · workers · scheduler · queues · PostgreSQL · model gateway · memory engine ·
artifact store · cache layer · MCP adapter · A2A dispatcher · voice plane.

Without this, the platform reports that an agent is slow while the real cause is queue
starvation, database contention, cache stampede, or a degraded downstream server.

## 15.5 Evaluation → deployment feedback loop

Evaluation is wired into the lifecycle, not run beside it.

```
AgentVersion → Evaluate → gate → Deploy (canary) → Production feedback
                  ▲                                        │
                  └────────────────────────────────────────┘
                              promote │ rollback
```

Capture: user feedback · task success/failure · human corrections · approval and rejection rates ·
regression results · latency and cost · memory effectiveness · tool-use quality.

**The eval system tests whether compensating mechanisms actually improve outcomes** —
summarization, compaction, memory tiers, planning scaffolds. This is what converts §0.5 from a
principle into an enforced gate: a mechanism that cannot demonstrate benefit fails its eval and
is removed.

---

# §16. Security, identity, and residency

## 16.1 Data residency — two distinct constraints

**Constraint 1 — Telemetry. Absolute.** Traces, metrics, evals, and prompt/completion logs never
leave our perimeter. LangSmith and equivalents are out of scope. Self-hosted without exception.

**Constraint 2 — Inference, media, and external capability. Policy-gated.** Third-party LLM, STT,
TTS providers, external MCP servers, and remote peers are **egress**, materially larger than
telemetry.

**Enforcement, not configuration.** Classify every registry entry `internal` or `external`. The
agent's data class gates which it may reach. **The model gateway (§9) and MCP adapter are the
enforcement points** — an agent marked `regulated` is structurally unable to reach an external
provider, regardless of what its spec names.

## 16.2 Three-way capability intersection

```
effective capability = spec ∩ service grant ∩ user grant
```

Where an end user is present, tool authorization resolves against **their** entitlements, not the
calling service's. Absence of a required user grant is a **rejection**, never a fallback to
service identity — silent fallback is how an assistant leaks HR records.

The delegation chain carries user identity across A2A hops, so a peer reaching a server on the
originating employee's behalf uses that employee's access.

## 16.3 Credential broker

Credentials never enter model context and are never ambient service credentials.

```
Agent → Credential Broker → short-lived scoped credential → Tool / MCP / Peer
```

Workload identity · short-lived credentials · audience restriction · tenant restriction · **user
delegation** · automatic rotation · secret isolation · full auditability.

This is the concrete implementation of §0.1 and the mechanism behind §13.2's no-token-passthrough
rule.

## 16.4 Controls

Tenant and sub-tenant isolation · user isolation · agent-level authorization · tool-level and
capability-level permissions · mutual authentication for service and agent identity · audit
logging · encryption at rest and in transit · retention policies · configurable PII handling ·
DLP hooks · configurable trust levels · access-controlled traces and memory · network policies.

**Protocol connectivity is subordinate to platform policy.** An agent never gains access to a
tool, resource, or peer merely because it is technically reachable.

## 16.5 Multi-region and disaster recovery

A clear future path is required, with explicit answers to:

- **Can a run resume in another region?** If yes, what state must replicate first.
- **Can artifacts follow it?** Replication lag versus run resumption.
- **What happens to a voice session during regional failure?** A media session cannot migrate
  mid-call; define the degradation.
- **Which workloads may cross regions, and which regulated workloads may not?**

Regional execution · database replication · artifact replication · region-aware provider routing ·
residency-constrained placement · failover · cross-region run recovery. Phase 5, but the
residency classification it depends on lands in Phase 1.

---

# §17. Control plane

## 17.1 Registries

Agent · AgentVersion · Model · **Prompt** · **Policy** · Tool · MCP server · Peer · Voice ·
Trigger.

## 17.2 Prompt registry

Prompts are versioned platform resources, not blobs inside agent definitions.

Immutable versions · ownership · approval status · content hashes · environment bindings ·
rollout and promotion.

Referenced from AgentSpec as `{ ref: "prompts/collections@v11" }`. **Avoid embedding large
mutable prompt blobs in production agent definitions** — it defeats versioning, review, and
prompt caching (§10).

## 17.3 Policy registry

Policies are versioned resources referenced by many agents, so a residency or spend rule updates
in one place rather than across fifty specs.

Tool permissions · model restrictions · data residency · spend limits · human approval
requirements · tenant policies · trust boundaries.

## 17.4 Agent lifecycle

```
Create → Validate → Approve → Version → Deploy → Observe → Evaluate
                                                              │
                              Canary → Promote / Rollback ◄───┘
                                          ↓
                                   Deprecate → Archive
```

Immutable versions · staging vs production · **canary and percentage rollout** · **shadow
execution** · rollback · version pinning · **safe live-thread migration** · deprecation.

Shadow execution — running a new version alongside the current one without serving its output —
is how a prompt or model change is validated against real traffic before promotion. With §15.5
this is what makes agent changes a normal deployment rather than a leap.

## 17.5 Admission control

Every spec passes admission before an AgentVersion exists. **Dynamic specs are untrusted input.**

```
AgentSpec → schema validation → capability intersection (§16.2) → policy checks
          → tenant & budget checks → residency checks → approve / reject
```

Covers model access · tool access · MCP servers · A2A peers · budgets · data classes · namespaces ·
production deployment · peer exposure.

Rejections are explicit. **Silent narrowing hides bugs** — a spec requesting ungranted capability
is refused, not filtered.

## 17.6 Agent catalog

A discoverable catalog of agents, tools, MCP servers, models, prompts, and capabilities, **derived
from the canonical AgentSpec.** No duplicate registration system where metadata can be derived.

## 17.7 Reconciliation and tenancy

Reconciler with drift detection and a status subresource reporting observed state and conditions.
Namespace isolation, RBAC, quotas, rate limits, hierarchical budgets (§5.2).

> **Namespace prerequisite.** §13.3 makes namespaces the enforcement point for the sub-agent /
> peer boundary. A namespace must map to exactly one owning team.

---

# §18. API, SDK, and triggers

## 18.1 Two agent lifetimes

| | **Registered** | **Ephemeral** |
|---|---|---|
| Analogue | Deployment | Job |
| Definition | Persisted, named, versioned | Inline in the request |
| Discoverable / peer | Yes | **No** |
| Memory scopes | All | Thread + run only |
| Central upgrade | Yes | No |
| Onboarding cost | Registration | One POST |

Both produce an **AgentVersion**; ephemeral ones are anonymous and content-addressed so runs stay
replayable. The ephemeral path is what makes the sub-one-day target achievable — do not force
registration up front.

## 18.2 Trigger and dispatch layer

Generic execution triggers; **not** business scheduling.

```
HTTP request → Run        Event → Run          Schedule → Run
Webhook → Run             External callback → Run
```

```yaml
triggers:
  - type: event
    source: payments
    event: payment.failed
  - type: webhook
    path: /external/result
  - type: schedule
    cron: "0 9 * * 1"
```

**The platform provides the primitive; the consuming service owns domain scheduling.** Campaign
orchestration, calling windows, consent checks, and retry cadence stay in the consuming service.

## 18.3 API surface

```
# Control plane
POST   /v1/agents                    PUT /v1/agents/{name}
GET    /v1/agents/{name}             GET /v1/agents/{name}/versions
POST   /v1/agents/{name}/promote     POST /v1/agents/{name}/rollback

# Execution
POST   /v1/agents/{name}/runs        POST /v1/runs        # inline or ref+overrides
GET    /v1/runs/{id}                 GET  /v1/runs/{id}/events   # SSE, Last-Event-ID
POST   /v1/runs/{id}/cancel          GET  /v1/runs/{id}/checkpoints
POST   /v1/runs/{id}/fork

# Interactions
GET    /v1/interactions/{id}         POST /v1/interactions/{id}/respond

# Threads
POST   /v1/threads                   GET  /v1/threads/{id}/runs
```

## 18.4 Execution modes

`sync` · `stream` · `async`. **All durable by default** — mode is delivery, not durability. A
`sync` request whose client disconnects continues executing and remains resumable by run ID.

## 18.5 Governance of inline specs

Inline specs never widen authority; they select from capability the caller already holds. No
inline MCP server definitions — servers are referenced by registry ID only, or hash pinning and
tenant approval are bypassed. Registered specs declare an `overridable` field allowlist,
default deny.

Track distinct inline spec hashes per calling service. Rising cardinality means either the caller
should register, or **the caller is interpolating variable content into the system prompt** — a
direct prompt-injection path, and a cache-defeating one (§10).

## 18.6 SDK

```typescript
const agent = await agentRuntime.register({
  name: "coding-agent",
  namespace: "platform-eng",
  model:  { ref: "internal/default" },
  prompt: { ref: "prompts/code-review@v3" },
  policy: { ref: "policies/internal-readonly@v2" },
  tools:  ["git.read", "repo.checkout", "lint.run"],
  memory:    { working: true, episodic: true, procedural: true },
  execution: { durability: "strict" },
  overridable: ["input", "model.ref"],
});

const run = await agent.run({ threadId, tenantRef, onBehalfOf, input });
for await (const event of run.stream()) { … }

// Ephemeral
const result = await agentRuntime.runOnce({
  agent: { model: { ref: "internal/fast" }, systemPrompt: "…", tools: ["document.read"] },
  input: { documentId },
  mode: "sync",
});
```

---

# §19. AgentSpec

```yaml
apiVersion: agents.company.internal/v1
kind: Agent
metadata:
  name: voice-loan-collections
  namespace: voice-ops
  owner: voice-ops@company

spec:
  model:  { ref: <registry-id> }          # routed through the gateway (§9)
  prompt: { ref: "prompts/collections@v11" }
  policy: { ref: "policies/regulated-voice@v4" }

  identity:
    workloadIdentity: <auto-issued>

  execution:
    durability: strict | relaxed          # governs conversational state only
    checkpointing: { strategy: step | interval }
    retries:  { max: 3, backoff: exponential }
    timeouts: { step: 30, run: 1800 }
    limits:   { maxSteps: 120, maxTokens: …, maxCost: … }

  transport: sse | voice-webrtc | voice-telephony | webhook | poll

  triggers:
    - { type: event, source: payments, event: payment.failed }

  memory:
    enabled: true
    tiers: [working, conversational]
    scope: { semantic: tenant, episodic: tenant }
    retention: { episodic: 90d }

  context:
    compaction:    { enabled: true, trigger: <threshold> }
    summarization: { enabled: true, strategy: hierarchical }
    offloading:    { enabled: true, store: artifacts }

  tools:
    - ref: loan.balance.read
      effects: [readOnly, cacheable]
      cache: { ttl: 60s, scope: tenant }
    - ref: payment.link.send
      effects: [essential, idempotent]
      idempotencyKey: "${runId}:${loanId}"
    - ref: refund.initiate
      effects: [essential, nonIdempotent, humanApprovalRequired, compensatable]
      compensation: refund.reverse

  subAgents: []                            # same namespace only

  protocols:
    mcp:
      revision: "<pinned dated revision>"
      servers:
        - ref: <registry-id>
          transport: stdio | streamable-http
          residency: internal | external
          tools: [<explicit allowlist>]
          definitionHash: <pinned>
          allowSampling: false
    a2a:
      version: "<pinned>"
      exposeAsPeer: false
      peers: []

  speech:
    tts: { ref: <registry-id>, residency: internal }
    stt: { ref: <registry-id>, residency: internal }

  backpressure:
    maxConcurrentRuns: 500
    onSaturation: queue | throttle | shed

  observability:
    tracing: true
    redaction: <policy-ref>

  rollout:
    strategy: canary
    canaryPercent: 5
    shadowFrom: <previous-version>
    promotionGate: { evalSuite: <ref>, minScore: … }

  security:
    dataClass: internal | regulated
    tenantIsolation: strict

  overridable: [input, execution.limits.maxTokens]
```

---

# §20. Non-goals

The platform must not become:

- a generic workflow engine
- a business system of record
- a campaign scheduler
- a Slack, telephony, or GitHub product
- a second MCP ecosystem or a second A2A task/event store
- a framework-specific runtime contract

And specifically:

- No hosted observability or eval vendor, under any framing.
- No WebSocket control plane for browser clients; no managed WebSocket gateway billed per-message.
- No datastore beyond Postgres and object storage without written justification.
- No large binary content in Postgres.
- No cross-namespace sub-agents. No agents modeled as MCP tools.
- No MCP session lifecycle or session affinity — the protocol is stateless.
- No MCP server bound without hash-pinned definitions and tenant-scoped approval.
- No inline spec widening caller capability; no inline MCP server definitions.
- No agent-scoped memory without registration.
- No caching of side-effecting operations; no cache in the replay path.
- No framework or protocol concepts in the persisted model or public API.
- No compensating mechanism retained without an eval demonstrating benefit.
- No claim of exactly-once semantics where not achievable.
- No duplicate capability-registration system where metadata can be derived.

---

# §21. Deliverables

1. System architecture — components, NestJS module layout, control/data/media plane splits.
2. Domain model — §3 entities, relationships, lifecycle, and the three-state separation.
3. Execution engine — state machine, queueing, leases, heartbeats, durability tiers, checkpoint
   and resume, run-graph semantics.
4. Persistence model — schemas, transaction boundaries, indexing, partitioning, retention,
   **event schema versioning and upcasters**, tenant columns.
5. Resource governance — backpressure at every level of §5.1, saturation policies, hierarchical
   budgets.
6. Memory architecture — tiers, scoping, consolidation, transcript fidelity, provenance, per-tier
   disable path.
7. Context engine — summarization, compaction, retrieval, eviction, virtual context.
8. Tool layer and **effect contract taxonomy**, with the runtime behavior each class implies.
9. **Model gateway** — routing, fallback, health, cost accounting, residency enforcement.
10. **Cache design** — layers, keys, invalidation, and the replay-isolation guarantee.
11. Artifact storage and **full lifecycle** — versioning, TTL, GC, dedup, legal hold, lineage.
12. Transports — SSE contract with resume semantics; voice media plane; **voice latency budget**
    with per-stage millisecond targets.
13. Protocol layer — MCP client and security model; A2A dual-binding with **conformance suite**.
14. **Interaction runtime** — entity model, routing, authorization, expiry, multi-hop delegation.
15. Observability — unified events, graph traces, **lineage**, **platform self-observability**,
    replay.
16. **Evaluation and deployment loop** — eval suites, promotion gates, canary, shadow, rollback.
17. Identity, **credential broker**, three-way capability intersection, residency enforcement
    points.
18. Sandbox design — isolation technology, uniform application, escape threat model.
19. Control plane — registries, prompt and policy versioning, admission control, catalog,
    reconciliation.
20. API, SDK, **trigger layer**, and both agent lifetimes.
21. **Multi-region and DR** — explicit answers to §16.5's four questions.
22. Scalability — worker scaling, execution distribution, backpressure interaction.
23. Operational model — deployment, upgrades, migrations, worker lifecycle, dead-letter, DR,
    on-call runbooks.
24. **Provider benchmark plan** — vendor latency claims diverge from independent measurement and
    neither reflects your region or concurrency.
25. **Protocol conformance and version-drift plan.**
26. Example workloads — end-to-end for all seven classes of §1.1.
27. **Phasing plan** — vertical slice, sequencing, measured time-to-first-agent.
28. Trade-offs, failure modes, scaling limits — especially of the Postgres-centric choice — and
    where you would deviate and why.

---

# Appendix A — Decisions required before implementation

1. **External-capability residency policy** (§16.1). Legal, not architectural. Blocks all external
   adapters: speech, third-party MCP, remote peers, and possibly third-party model APIs.
2. **Acceptable loss window at the `relaxed` tier** (§4.3).
3. **Namespace-to-team mapping** (§17.7). §13.3 depends on one namespace = one owning team.
4. **Sandbox isolation technology** (§0.4). Before the first tool executes.
5. **Effect classification of the initial tool set** (§8.3). Determines retry safety, caching, and
   approval gates. Phase 1.
6. **Capability grant granularity** — service identity or namespace? §16.2 is unimplementable
   until settled.
7. **Kill criteria** (§0.7).

# Appendix B — Verification notes

Fast-moving external state; **re-verify against primary sources before implementation.**

- **MCP's most recent revision made the protocol core stateless** and removed the GET stream
  endpoint and protocol-level sessions — a breaking transport change. Any guidance describing MCP
  session lifecycle or connection pooling predates this. Published docs have shown inconsistent
  "current version" strings; confirm the target revision directly.
- **A2A reached 1.0** under Linux Foundation governance with signed Agent Cards formalized.
- **Browser support for streaming request bodies** (§12.2) remains partial.
- **Speech provider latency, pricing, and concurrency ceilings** change frequently and vendor
  figures diverge from independent measurement. Benchmark from the deployment region.
