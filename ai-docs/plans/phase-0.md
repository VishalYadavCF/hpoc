# Phase 0 — walking skeleton

Milestone 0 of `lld.md`. Everything here is scaffolding: no agent runs, no LLM call, no tool. The
goal is that the *shape* of the system is right and enforced, so Phase 1 lands features on rails
rather than laying track while driving.

**Exit criterion:** three processes boot against a migrated database, `/healthz` is green on all
three, the layering rules fail the build when violated, and one integration test proves a
transaction that writes a row and appends an event in the same commit.

---

## 0.1 Repository and build

| Task | Detail | Done when |
|---|---|---|
| Three entrypoints | `src/main.api.ts`, `src/main.worker.ts`, `src/main.scheduler.ts`. Worker and scheduler use `NestFactory.createApplicationContext` plus a bare health listener | `npm run start:api\|worker\|scheduler` each boot and exit cleanly on SIGTERM |
| Directory skeleton | `platform/ domain/ adapters/ api/` per `lld.md` §4, with an `index.ts` barrel per bounded context | Empty modules import and compile |
| ESM discipline | `"type": "module"`, `moduleResolution: nodenext` — every relative import ends `.js` | `tsc --noEmit` clean; no `require` anywhere |
| Core-compiles-alone check | `tsconfig.core.json` excluding `src/adapters/**` and `src/api/**` | `tsc -p tsconfig.core.json` passes. **This is §2.1 made testable** |
| Layering rules | `dependency-cruiser` config encoding `lld.md` §3 | A deliberate domain→adapter import fails CI |
| Graceful shutdown | `app.enableShutdownHooks()`; worker drains its lease before exit | SIGTERM releases leases rather than waiting for expiry |

**Watch:** the core-compiles-alone job is the one people delete when it gets inconvenient. It is the
only mechanical defence of §0.3, and by the time it is inconvenient it is doing its job.

## 0.2 Configuration

| Task | Detail | Done when |
|---|---|---|
| `env.schema.ts` | Zod schema, **collect-all** validation — report every missing var, not the first | A boot with three bad vars names all three |
| Per-process config | Each entrypoint validates only what it needs; the api does not require `WORKER_POOL` | Worker boots without SSE settings |
| Secrets | Never in env for anything the broker will mint later. `DATABASE_URL` and OTLP endpoint only | No provider API key in the schema |

Mirror `ap-executor`'s `env.schema.ts` structure — the two services should feel the same to operate.

## 0.3 Persistence

| Task | Detail | Done when |
|---|---|---|
| Migration runner | Numbered `.sql` files, `schema_migrations` ledger, advisory-locked so concurrent pods cannot race | Applying twice is a no-op |
| `0001_initial.sql` | `db/schema.sql` split into ordered migrations | Empty DB → full schema |
| Schema/migration agreement | CI applies migrations to an empty DB and diffs against `db/schema.sql` | A migration that drifts from the reference fails CI |
| Kysely + codegen | `kysely-codegen` against the migrated schema, types committed | Dropping a column breaks the build |
| Two pools | `default` (pooled) and `listener` (direct, bypasses PgBouncer) | Two distinct `DATABASE_URL`s in config |
| `UnitOfWork` | ALS-backed; joins an ambient transaction or opens one | A nested repository call shares the caller's `Tx` |
| Partition maintenance | Scheduler job creating next month's `events` / `usage_ledger` / `audit_log` partitions ahead of time | A partition exists before it is needed |

**Watch:** the `listener` pool exists because `LISTEN` holds a session and breaks under PgBouncer
transaction pooling (§12.1). Wiring both pools now costs ten minutes; discovering it in staging
costs a day.

## 0.4 Context and cross-cutting

| Task | Detail | Done when |
|---|---|---|
| `PlatformContext` + ALS | Shape per `lld.md` §6, identical on api and worker | Domain code cannot tell which process it runs in |
| Tenant-scoped repositories | Base repository appends `org_id`/`namespace_id`/`tenant_ref` predicates from context | A query without a tenant predicate is not expressible |
| Guards | `ServiceAuthGuard`, `TenantGuard` — a tenant with no grant is **403, not empty** | Integration test asserts 403 |
| Exception filter | Typed taxonomy per `lld.md` §8 | 429 carries `Retry-After`, `level` and `scopeRef` |
| Structured logging | Reads context; every line carries `runId`, `tenantRef`, `traceId` | No `console.log` in `src/` |

## 0.5 Observability

| Task | Detail | Done when |
|---|---|---|
| OTel bootstrap | Self-hosted collector endpoint. **No hosted vendor, including in staging** (§16.1) | Traces land in the local collector |
| Trace context | W3C propagation; inbound context accepted only per tenant trust policy | Untrusted inbound `traceparent` is dropped, not adopted |
| `/healthz` `/readyz` | Liveness is process-only; readiness checks DB reachability and migration currency | A pod on an unmigrated DB is not ready |
| `/metrics` | Prometheus registry with the §9 metric names stubbed at zero | `queue_depth` and `lease_age_seconds` scrape |

## 0.6 Scheduler singleton

| Task | Detail | Done when |
|---|---|---|
| Leader lock | `pg_try_advisory_lock` on a dedicated connection held for process life | Two schedulers, one active; killing the leader promotes the other |
| Job scaffold | Registered no-op jobs: lease reclaim, outbox pump, interaction expiry, artifact GC, partition maintenance | Jobs tick and log; none does work yet |

## 0.7 Test harness

| Task | Detail | Done when |
|---|---|---|
| Integration Postgres | testcontainers where Docker exists; `pg_ctl` local cluster fallback | `npm run test:integration` green on a clean machine |
| Per-test isolation | Transaction-per-test rollback, or template-database clone | Tests do not see each other's rows |
| Constraint tests | Port the 13 invariant probes from the schema work into Vitest | Cross-namespace sub-agent, cacheable non-idempotent tool, etc. all rejected **by the database** |
| CI wiring | lint · `tsc` · `tsc -p tsconfig.core.json` · dependency-cruiser · unit · integration | All green on an empty feature branch |

**Watch:** the constraint tests assert the *database* rejects these, not that a service layer does.
The whole point of putting §8.3 and §13.3 in CHECK constraints is that they hold even when a future
code path forgets.

---

## Explicitly not in Phase 0

No run engine, no queue claim, no event append, no adapter, no SSE, no tools, no model call. Each is
a Phase-1 milestone with its own exit criterion in `lld.md` §12. Phase 0 ends the moment the
skeleton stands up — pulling any of these forward turns a two-day scaffold into a two-week one and
delays the milestone that actually matters, which is milestone 4: **a durable run, end to end, on
the echo adapter.**

## Decisions needed before Phase 1 starts

None of these block Phase 0 — that is why it is separated — but all three block milestones inside
Phase 1, so start the conversations now.

1. **Capability grant granularity** — service identity or namespace? Blocks milestone 2.
2. **Sandbox technology** — container now, microVM at Phase 3, per `lld.md` §13.3. Blocks milestone 8.
3. **Entitlements for a run with no interactive human** — publish-time author or run-time service
   identity? Blocks consumer 01's integration at milestone 10.
