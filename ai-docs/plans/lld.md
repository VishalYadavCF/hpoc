# Low-level design — NestJS agent platform

Companion to `../pwd.md` (requirements), `../api-spec.md` (surface), `../../db/schema.sql`
(persistence) and `../client-interactions/` (the three consumers this must serve).

**Scope:** the Phase-1 substrate (§0.6) in implementable detail, with the module architecture for
all five phases laid out so later subsystems have a declared home. **Not** in scope: prompts,
agent behaviour, or anything a consuming service owns.

**Stack as it stands:** NestJS 12, TypeScript 6, **ESM** (`"type": "module"`, `moduleResolution:
nodenext` — every relative import carries a `.js` extension), Vitest, oxlint, Express adapter.

---

## 1. Process topology

§2.3 requires workers to scale and fail independently of the API, and a control-plane deploy must
not interrupt in-flight runs. That is three deployables from one codebase, not one process with
three modes.

```
┌─────────────┐   ┌──────────────┐   ┌───────────────┐
│  api        │   │  worker      │   │  scheduler    │
│  HTTP + SSE │   │  run loop    │   │  singleton    │
│  stateless  │   │  N replicas  │   │  1 active     │
│  HPA on RPS │   │  HPA on queue│   │  leader lock  │
└──────┬──────┘   └──────┬───────┘   └───────┬───────┘
       └─────────────────┴───────────────────┘
                    PostgreSQL
```

| Deployable | Entrypoint | Nest bootstrap | Responsibilities |
|---|---|---|---|
| **api** | `src/main.api.ts` | `NestFactory.create` | Control-plane REST, execution REST, SSE fan-out. Holds no run |
| **worker** | `src/main.worker.ts` | `createApplicationContext` + tiny health server | Claims leases, drives the run loop, executes steps and tools |
| **scheduler** | `src/main.scheduler.ts` | `createApplicationContext` | Cron triggers, lease reclamation, outbox pump, interaction expiry, artifact GC. Single active instance via `pg_try_advisory_lock` |

The scheduler is deliberately *not* folded into the worker. Its jobs are singleton-by-nature
(reclaiming another worker's expired lease, expiring interactions), and running them on every
worker replica means N races where one is correct.

**Leader election:** `SELECT pg_try_advisory_lock($schedulerLockKey)` on a dedicated connection
held for the process lifetime. Losing the connection releases the lock; the next instance takes it.
No extra dependency, consistent with §11.3's Postgres-centric bet.

---

## 2. Module architecture

Four bands, and the dependency direction is one-way downward. A band never imports from a band
above it.

```
┌──────────── API band ─────────────────────────────────────────────────┐
│ ControlPlaneApiModule · ExecutionApiModule · OpsApiModule             │
│ StreamingModule (SSE)                                                 │
└───────────────────────────┬───────────────────────────────────────────┘
┌───────────────────────────▼─── Adapter band ──────────────────────────┐
│ DeepAgentsAdapterModule · EchoAdapterModule   (framework, §2.1)       │
│ McpAdapterModule (P3) · A2aAdapterModule (P4) · VoiceAdapterModule(P5)│
│ ContainerSandboxModule · ProviderAdapters (per LLM vendor)            │
└───────────────────────────┬───────────────────────────────────────────┘
┌───────────────────────────▼─── Domain band ───────────────────────────┐
│ RunEngineModule · QueueModule · EventLogModule · CheckpointModule     │
│ ToolRuntimeModule · ModelGatewayModule · AdmissionModule              │
│ IdentityModule · TenancyModule · AuthorizationModule                  │
│ CredentialBrokerModule · GovernanceModule · OutboxModule              │
│ RegistryModule (agents·versions·models·prompts·policies·tools·servers)│
│ MemoryModule(P2) · ContextEngineModule(P2) · ArtifactModule(P2)       │
│ CacheModule(P2) · InteractionModule(P3) · LineageModule(P3)           │
└───────────────────────────┬───────────────────────────────────────────┘
┌───────────────────────────▼─── Platform band ─────────────────────────┐
│ ConfigModule · PersistenceModule · ContextModule (ALS)                │
│ ObservabilityModule · ClockModule · IdModule                          │
└───────────────────────────────────────────────────────────────────────┘
```

### Why the framework adapter is in the adapter band

§0.3 says the persisted model must be framework-neutral and mandates a **second orchestration
adapter, however minimal, from the first release** — "if writing it is hard, the abstraction has
already leaked."

`EchoAdapterModule` is that second adapter: a deterministic loop that emits one model step, one
tool step and one completion, with no LLM behind it. It costs ~150 lines, it is the fastest
integration test in the suite, and it is the only thing that will catch a `deepagents` concept
seeping into `steps` or `events`. It ships in Phase 1, not later.

### Registry split

`RegistryModule` is one Nest module but several providers, because the tables are related and the
admission path reads all of them in one pass. It re-exports narrow ports (`AgentRegistry`,
`ToolRegistry`, `ModelRegistry`, …) so consumers depend on the port, not the module's breadth.

---

## 3. Layering rules, and how they are enforced

Rules are worthless unless a build step fails on them. §2.1's claim — *"the core runtime must
compile with every protocol adapter removed"* — is a testable statement, so test it.

| Rule | Enforcement |
|---|---|
| Domain never imports Adapter or API | `dependency-cruiser` rule, run in CI |
| Domain never imports `deepagents`, `@langchain/*`, MCP or A2A SDKs | `dependency-cruiser` `pathNot` on `src/domain/**` |
| No protocol/framework vocabulary in persisted types | `src/domain/**/persistence/*.ts` may not import from `src/adapters/**` |
| Adapters may not import each other | dependency-cruiser |
| **The core compiles with adapters removed** | CI job: `tsc -p tsconfig.core.json`, which excludes `src/adapters/**` and `src/api/**`. A leak becomes a type error |

That last job is the one that matters. It converts §0.3 from a principle into a red build.

---

## 4. Directory layout

```
src/
  main.api.ts  main.worker.ts  main.scheduler.ts
  platform/
    config/        env.schema.ts  config.module.ts
    persistence/   db.ts  unit-of-work.ts  listener.ts  migrations/
    context/       request-context.ts  als.ts
    observability/ tracing.ts  metrics.ts  self-observability.ts
    clock/  id/
  domain/
    identity/  tenancy/  authorization/  credential-broker/
    registry/    agent/ model/ prompt/ policy/ tool/ mcp-server/ peer/ trigger/
    admission/
    run-engine/  run.aggregate.ts  state-machine.ts  run.repository.ts  run-loop.ts
    queue/       claim.ts  lease.ts  reclaimer.ts
    event-log/   append.ts  upcasters/  replay.ts  taxonomy.ts
    checkpoint/  tool-runtime/  model-gateway/  outbox/  governance/
    ports/       framework-adapter.port.ts  sandbox.port.ts  model-provider.port.ts
  adapters/
    framework/   deep-agents/  echo/
    sandbox/     container/
    providers/   openai/ anthropic/ google/ ...
    protocol/    mcp/ (P3)  a2a/ (P4)
  api/
    control-plane/  execution/  ops/  streaming/
    guards/  interceptors/  filters/  dto/
test/
  unit/  integration/  contract/  replay-corpus/
```

`src/domain/ports/` is the seam. Every port is an `interface` plus a `Symbol` token; adapters
provide implementations; domain code injects the token and never the class.

```ts
// src/domain/ports/framework-adapter.port.ts
export const FRAMEWORK_ADAPTER = Symbol('FrameworkAdapter');

export interface FrameworkAdapter {
  readonly id: string;                       // 'deep-agents' | 'echo'
  /** Drives one increment. Returns the next durable step, never a whole run. */
  advance(input: AdvanceInput): Promise<AdvanceOutput>;
}
```

`advance()` returning **one step** rather than running a loop is the central design choice of the
adapter boundary: it is what lets the platform own checkpointing, cancellation, budget enforcement
and the event log, while the framework owns reasoning. A framework that can only run to completion
(as `deepagents`' `invoke()` does today) is wrapped with its callback stream translated into steps —
which is precisely what consumer 01's `AgentTracer` already does, and why that code is the model
for this adapter.

---

## 5. Persistence layer

### No ORM

`db/schema.sql` uses partitioned tables, native enums, array columns, composite foreign keys,
`CHECK` constraints carrying business rules, partial indexes and `pgvector`. An entity-mapping ORM
fights every one of those, and the constraints are load-bearing — they are where §8.3 and §13.3 are
enforced.

**Decision: `kysely` (typed query builder) over `pg`.** Types are generated from the live schema
(`kysely-codegen`), so a migration that drops a column breaks the build. Raw SQL where a query needs
it (`FOR UPDATE SKIP LOCKED`, upserts, recursive lineage) via `sql` template tags, still typed.

**Migrations: plain `.sql` files**, numbered, applied by a small runner that records them in
`schema_migrations`. `db/schema.sql` remains the readable whole-schema reference; migrations are the
executable history. CI asserts they agree by applying migrations to an empty database and diffing
against `schema.sql`.

### Unit of work

```ts
export interface UnitOfWork {
  /** Joins the ambient transaction if one is open, else opens one. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
```

Backed by `AsyncLocalStorage`, so a repository three calls deep joins the caller's transaction
without threading a handle through every signature. **Every write path takes a `Tx`.** A repository
method that opens its own transaction is a bug — it breaks the "append the event in the same
transaction as the state change" rule that §4.5's guarantees rest on.

### Two connection pools, deliberately

| Pool | Used by | Why separate |
|---|---|---|
| `default` | everything | Normal pooled access, PgBouncer-friendly |
| `listener` | `StreamingModule` only, 1 connection per api pod | §12.1: `LISTEN` holds a session and **breaks under PgBouncer in transaction pooling mode**. This connection bypasses the pooler and talks to Postgres directly |

This is called out because it is the failure that looks like "SSE just stops working in staging" and
takes a day to find.

---

## 6. Request and run context

One `AsyncLocalStorage` store, established by a guard on the API side and by the run loop on the
worker side, carrying identical shape so domain code cannot tell which process it is in:

```ts
export interface PlatformContext {
  orgId: string;
  namespaceId: string;
  tenantRef: string;                    // §5.2 — first-class, never optional
  callerPrincipalId: string;
  onBehalfOfPrincipalId: string | null; // null is meaningful: no interactive user
  authorizingHumanId: string | null;    // §0.1 — the scheduled-run answer (see doc 01)
  delegationChain: DelegationHop[];
  traceId: string;
  correlationId: string;
  runId?: string;
  lease?: { owner: string; epoch: number };   // worker only — see §7.2
}
```

Two things fall out of having this:

- **Repositories append tenant predicates from context**, not from arguments. A query that forgets
  `tenant_ref` is impossible to write, which is what makes §5.2 hold before RLS is switched on in
  Phase 4.
- **The logger and the OTel span** read context directly, so every log line and span carries the
  delegation chain without a call site passing it.

### API pipeline

| Stage | Component | Does |
|---|---|---|
| Guard | `ServiceAuthGuard` | mTLS peer identity or signed service token → `callerPrincipalId` |
| Guard | `TenantGuard` | Resolves `X-Tenant-Ref` against the caller's grants. **A tenant the caller has no grant for is a 403, not an empty result** |
| Interceptor | `ContextInterceptor` | Builds `PlatformContext`, opens the ALS scope |
| Interceptor | `TracingInterceptor` | OTel span with GenAI semantic conventions; accepts inbound W3C trace context **subject to tenant trust policy** (§15.2) |
| Interceptor | `IdempotencyInterceptor` | On `Idempotency-Key`, replays the stored response for a completed request rather than re-executing |
| Interceptor | `AdmissionInterceptor` | Backpressure check before work is queued (§5.1) |
| Filter | `PlatformExceptionFilter` | Typed error taxonomy → status + machine-readable body |

---

## 7. Core mechanisms

### 7.1 Run creation

One transaction, four writes, then a notify. Anything less and a crash between them strands a run.

```
BEGIN
  admission  → AgentVersion (registered lookup, or upsert-by-spec_hash for ephemeral)
  INSERT runs           (status='queued', delegation chain, budget ceiling)
  INSERT run_queue      (visible_at=now(), priority)
  UPDATE runs SET last_event_seq = last_event_seq + 1 RETURNING seq
  INSERT events         ('run.created', schema_version, seq)
COMMIT
NOTIFY run_ready, '<runId>'
```

The ephemeral upsert is `INSERT ... ON CONFLICT (org_id, spec_hash) DO UPDATE SET spec_hash =
EXCLUDED.spec_hash RETURNING id` — a degenerate update so `RETURNING` fires on both paths. That one
line is what collapses consumer 01's thousand identical workflow-node runs onto one `AgentVersion`
and one prompt-cache key.

### 7.2 Claim, lease, heartbeat — and fencing

Claim, per §4.4:

```sql
WITH claimed AS (
  SELECT run_id FROM run_queue
   WHERE lease_owner IS NULL AND visible_at <= now() AND worker_pool = $1
   ORDER BY priority, visible_at
   FOR UPDATE SKIP LOCKED
   LIMIT $2
)
UPDATE run_queue q
   SET lease_owner = $3,
       lease_epoch = q.lease_epoch + 1,
       lease_expires_at = now() + $4::interval,
       heartbeat_at = now(),
       attempts = q.attempts + 1
  FROM claimed WHERE q.run_id = claimed.run_id
RETURNING q.run_id, q.lease_epoch;
```

> **Schema addendum required:** `run_queue.lease_epoch bigint NOT NULL DEFAULT 0`. It is not in
> `db/schema.sql` today and it must be, for the reason below.

**The failure this prevents.** A worker stalls — a long GC pause, a hung syscall. Its lease expires,
the scheduler reclaims the run, worker B claims it and starts executing. Worker A wakes up with no
idea it lost ownership and writes a step. Two workers now advance one run, and the event log
interleaves two realities. Heartbeats do not prevent this; they only shorten the window.

**Fencing** closes it. Every durable write in the run loop asserts ownership in the same statement:

```sql
UPDATE runs SET status = $newStatus
 WHERE id = $runId
   AND EXISTS (SELECT 1 FROM run_queue
                WHERE run_id = $runId AND lease_owner = $me AND lease_epoch = $myEpoch);
-- 0 rows affected  ⇒  the lease is gone. Abandon locally; do not retry; do not roll forward.
```

Heartbeat runs at `leaseTtl / 3` and is itself fenced — an update affecting 0 rows tells the worker
it has been superseded, and the run loop aborts at the next step boundary rather than mid-tool-call.

### 7.3 Step execution and event append

Sequence allocation is what actually delivers §4.5's total per-run ordering — see the note in
`db/ERD.md` on why the partitioned primary key cannot do it:

```
BEGIN
  fence check (above)
  UPDATE runs SET last_event_seq = last_event_seq + 1 WHERE id = $1 RETURNING last_event_seq
  INSERT steps (...)
  INSERT events (run_id, seq, schema_version, event_type, ...)
  if durability = 'strict':  INSERT checkpoints (...)
COMMIT
NOTIFY events, '<runId>:<seq>'          -- id only: the ~8 KB payload cap (§12.1)
```

The `UPDATE ... RETURNING` takes the run's row lock, serialising allocation per run. It is also the
natural place the fence lives, so ordering and ownership are established by the same lock.

### 7.4 The run loop

```
claim → load run + last checkpoint
  loop:
    fence
    budget / step-limit / deadline check          → terminate if exceeded
    adapter.advance(state)                        → one step
    classify step:
       model_call  → ModelGateway
       tool_call   → ToolRuntime
       delegation  → child run + 'waiting'
       interaction → Interaction + 'waiting'
    persist step + event (+ checkpoint if strict)
    if waiting or terminal: release lease, exit
  finally: release lease
```

`relaxed` durability (§4.3, voice) batches checkpoints on a timer instead of writing per step —
but **tool invocations follow their effect contract independently**, so an `essential` tool inside a
`relaxed` run still writes synchronously. That is one branch in the persist step, not a separate
code path.

### 7.5 SSE — replay-then-tail without a gap

§12.1's requirements, and the one ordering subtlety that will otherwise produce a rare missing event.

**Subscribe before you replay.** The naive order — read history, then subscribe — drops any event
written between the read and the subscribe. Correct order:

```
1. LISTEN (already held; per-connection multiplexed by runId)
2. register an in-memory buffer for this runId
3. SELECT ... FROM events WHERE run_id = $1 AND seq > $lastEventId ORDER BY seq
4. flush buffered notifications, discarding any seq <= the max replayed
5. tail
```

Mechanics, each of which silently breaks streaming if missed:

- Raw response object, not Nest's `@Sse()` — it cannot express replay-then-tail or backpressure.
- `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. No gzip.
- `: ping` every 20s to survive load-balancer idle timeouts.
- `id:` is the run's `seq`, so `Last-Event-ID` is a cursor, not an opaque token.
- Honour `res.write()` returning `false` — a slow client must not balloon the buffer. Pause the
  tail, resume on `drain`, and if the buffer exceeds its bound, close the stream with a typed error
  so the client reconnects with `Last-Event-ID` rather than being silently starved.
- **Replay retention window is declared** (default 24h) and returned in the connect response, so a
  client reconnecting past it knows it must re-read state rather than assume continuity.

### 7.6 Tool runtime and effect enforcement

The effect array on `agent_version_tools` is not documentation; it selects the execution strategy.

| Declared | Strategy |
|---|---|
| `human_approval_required` | Create `interactions` row, run → `waiting`, **return before executing** |
| `read_only` + `cacheable` | Cache lookup. On hit, still write `tool_invocations` + a `tool.completed` event carrying the output, plus `cache.hit`. **Replay reads the event, never the cache** (§10) |
| `idempotent` | `INSERT tool_invocations ... ON CONFLICT (tool_id, idempotency_key) DO NOTHING`. Zero rows ⇒ a prior attempt owns it; read and reuse its result. Effectively-once |
| `non_idempotent` | Write the invocation row `status='running'` **before** the call. See below |
| `transactional` / `essential` | Outbox row in the same transaction as the state change |
| `compensatable` | On rollback, invoke `compensation_tool_id`, linked via `compensates_invocation_id` |

**The non-idempotent recovery rule.** A resumed run that finds one of its own `non_idempotent`
invocations in `status='running'` **does not know whether the side effect happened.** §4.5 forbids
pretending: it may not retry, and it may not assume success. It marks the invocation `indeterminate`
and takes the declared recovery path — fail the run, or raise an `interaction` of kind `approval`
asking a human to confirm. Which one is per-tool configuration, defaulting to fail.

This is three lines of code and the single most important correctness rule in the tool runtime.

### 7.7 Model gateway

```
resolve model ref
  → residency gate:  agent.data_class = 'regulated' ∧ model.residency = 'external'  ⇒ REJECT
  → capability match against models.capabilities  (§0.5)
  → rate limit / backpressure (model level, §5.1)
  → provider adapter call
  → on failure: fallback_model_id, and emit 'model.fallback' into the event log
  → usage_ledger insert, attributed org/namespace/tenant/agent/run
```

The residency gate is structural, not advisory: an agent marked `regulated` is unable to reach an
external provider **even if its spec names one** (§16.1). It is a check in the gateway, and the only
path to a provider is through the gateway.

### 7.8 Credential broker

```
tool needs credential
  → broker mints: audience-restricted, tenant-restricted, short-lived, on-behalf-of the caller
  → INSERT credential_grants  (jti, audience, scopes, on_behalf_of — never the token)
  → token handed to the SANDBOX, never into model context or a prompt
```

No token passthrough (§13.2). The MCP adapter receives minted headers, exactly as consumer 01's
executor already does at its "step 3.5" — that pattern is right and generalises.

### 7.9 Admission control

A pipeline of independent checks; **all rejections are collected, not short-circuited**, so an
author fixing a spec sees every problem at once rather than one per round trip.

```
schema validation
  → capability intersection: spec ∩ service grant ∩ user grant   (§16.2)
  → policy evaluation
  → budget and quota headroom
  → residency / data class
  → namespace and sub-agent rules
⇒ approve, or reject with the full reason list
```

Recorded in `admission_decisions` either way. **Silent narrowing is forbidden** (§17.5) — a spec
requesting an ungranted tool is refused, never filtered down to what is permitted.

---

## 8. Error taxonomy and backpressure

Saturation is not a 500. Every level in §5.1 declares its response, and the caller gets something
actionable.

| Condition | Status | Body | Header |
|---|---|---|---|
| Admission rejection | 422 | `{ code, rejections[] }` | — |
| No capability grant | 403 | `{ code: 'capability_denied', resource }` | — |
| Saturation, policy `throttle` | 429 | `{ code: 'throttled', level, scopeRef }` | `Retry-After` |
| Saturation, policy `shed` | 503 | `{ code: 'shed', level }` | `Retry-After` |
| Budget exhausted | 402 | `{ code: 'budget_exhausted', level }` | — |
| Run in a terminal state | 409 | `{ code: 'invalid_transition', from, to }` | — |
| Downstream MCP/provider failure | 502 | `{ code, upstream }` | — |

`level` and `scopeRef` in the saturation body matter: a caller throttled at the *MCP server* level
should back off differently than one throttled at the *tenant* level, and without those fields it
cannot tell.

---

## 9. Observability

- **OTel with GenAI semantic conventions**, self-hosted collector. §16.1 Constraint 1 is absolute:
  no hosted vendor, no exceptions, no "just for staging".
- **W3C trace context propagated across every hop.** Inbound context accepted at server endpoints
  **subject to tenant trust policy** — never blindly adopting a trace id from an untrusted caller.
- **Platform self-observability** (§15.4) is a first-class module, not a dashboard someone builds
  later: api, workers, scheduler, queue depth, lease age, PgBouncer saturation, gateway health,
  outbox lag. Without it the platform reports "the agent is slow" when the cause is queue starvation.

Metrics worth naming now because they are the 2am ones (§0.8): `queue_depth{pool}`,
`lease_age_seconds`, `runs_in_waiting{reason}`, `outbox_lag_seconds`, `sse_connections`,
`sse_dropped_slow_client`, `dead_letters_open`.

---

## 10. Testing

| Layer | Tool | Covers |
|---|---|---|
| Unit | Vitest | State machine transitions, effect resolution, upcasters, sequence allocation logic |
| Integration | Vitest + real Postgres | Every mechanism in §7. **Real Postgres, never a mock** — the schema's CHECK constraints are business rules, and a mock does not enforce them |
| Contract | Vitest | The `EchoAdapter` producing identical persisted history to a scripted `deepagents` run — the §0.3 leak detector |
| **Replay corpus** | CI job | An archived corpus of real event logs replayed on every change to the event model. **A change that breaks replay is a breaking change** (§0.2) |
| Layering | dependency-cruiser + `tsconfig.core.json` | §2.1's "compiles with adapters removed" |

Postgres for integration tests: testcontainers where Docker is available, and a
`pg_ctl`-managed local cluster as the fallback — the schema applies clean to 13+, with `pgvector`
required only for the memory module in Phase 2.

---

## 11. Configuration

One Zod-validated env schema, failing at boot with the full list of problems rather than the first.
The pattern is already proven in `ap-executor`'s `env.schema.ts`, and mirroring it keeps the two
services operationally similar.

Named now because they are the ones that change behaviour rather than tune it:

```
DATABASE_URL              LISTENER_DATABASE_URL      # direct, bypasses PgBouncer (§5)
WORKER_POOL               WORKER_CONCURRENCY
LEASE_TTL_MS              HEARTBEAT_INTERVAL_MS      # heartbeat = ttl/3
SSE_REPLAY_RETENTION_H    SSE_HEARTBEAT_MS
SANDBOX_PROFILE           SANDBOX_RUNTIME            # container | microvm (§0.4)
DEFAULT_DURABILITY        MAX_DELEGATION_DEPTH
OTEL_EXPORTER_OTLP_ENDPOINT
```

---

## 12. Phase-1 vertical slice and build order

§0.6's target is **under one day to first working agent**. The build order is therefore chosen so a
run executes end-to-end as early as possible, and every later step deepens rather than widens.

| # | Milestone | Done when |
|---|---|---|
| 0 | Walking skeleton | `db/schema.sql` applied by migrations; 3 processes boot; `/healthz` green. See `phase-0.md` |
| 1 | Context + persistence | ALS context, UoW, kysely types generated, tenant predicates enforced |
| 2 | Registry + admission | An `AgentVersion` can be created from a spec; rejections are explicit and collected |
| 3 | Run + queue + lease | `POST /v1/runs` → a worker claims, fences, and completes an empty run |
| 4 | **Echo adapter end-to-end** | A run produces steps, events and a checkpoint. **This is first-working-agent** |
| 5 | Event log + replay | Upcasters, replay corpus job, `GET /v1/runs/{id}/events/history` |
| 6 | SSE | Replay-then-tail with `Last-Event-ID`, heartbeats, slow-client handling |
| 7 | Model gateway | Two providers, fallback recorded, residency gate, `usage_ledger` |
| 8 | Tool runtime | Effect strategies incl. the non-idempotent recovery rule; sandbox port + container adapter |
| 9 | Credential broker | Minted, audited, never in model context |
| 10 | DeepAgents adapter | **Consumer 01 runs on the platform** — the Phase-1 exit criterion |
| 11 | Scheduler | Lease reclamation, outbox pump, dead-letter surfacing, runbooks |

Milestone 4 is the one to protect. An end-to-end durable run with a fake framework, on day one of
the build, is worth more than any amount of subsystem breadth — it makes every subsequent milestone
a change to a working system rather than a step toward a hypothetical one.

---

## 13. Deviations from `pwd.md`, stated rather than buried

**1. HTTP/2 at the edge, HTTP/1.1 upstream.** §12.1 requires "HTTP/2 end-to-end", and its stated
reason is that HTTP/1.1's ~6-connections-per-origin limit hangs streams once a user opens a third
tab. That limit is a **browser-to-edge** constraint; terminating HTTP/2 at the ingress and speaking
HTTP/1.1 to the api pods satisfies the reason in full while keeping the Express adapter already in
`package.json`. What must still hold upstream is no buffering and no gzip on the SSE path.
*If end-to-end HTTP/2 is wanted for a reason beyond the one stated, the change is the Fastify
adapter, and it is cheaper to make now than later — flagging it rather than deciding it unilaterally.*

**2. `run_queue.lease_epoch` is a required schema addition** (§7.2). Without it, fencing has to rely
on `lease_owner` alone, which is unsafe when the same worker id reclaims a run it previously lost.

**3. Sandbox: container in Phase 1, microVM declared for Phase 3.** §0.4 requires the boundary be
chosen before the first tool executes, and chosen *uniformly*. Container-per-run with a hardened
profile is honest for consumers 01 and 02; consumer 03 is what will need the microVM. The seam is
`tools.sandbox_profile`, already in the schema, so the upgrade is a registry change.

---

## 14. Open decisions, blocking

1. **Sandbox technology** (Appendix A #4) — recommendation in §13.3 above; needs a yes.
2. **Capability grant granularity** — service identity or namespace? (Appendix A #6.) §16.2's
   intersection is unimplementable until settled, and it is on the Phase-1 path at milestone 2.
3. **Whose entitlements govern a run with no interactive human** — publish-time author or run-time
   service identity? Blocks consumer 01. See `../client-interactions/01-ap-executor-ephemeral.md`.
4. **Relaxed-tier loss window** (Appendix A #2) — not Phase 1, but the `durability` branch in §7.4
   is written now and its semantics should be known before it is.
