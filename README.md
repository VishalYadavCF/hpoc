# Agent platform

A durable runtime for stateful, observable, long-lived AI agents.
Requirements are in `ai-docs/pwd.md`; the design that follows from them is in
`ai-docs/plans/lld.md`. This file is how to run it.

**Status:** Phase 1 substrate, working end to end. A run is created, queued, claimed under
a fenced lease, driven through a framework adapter, checkpointed at every
step boundary, streamed over SSE with resume, and accounted for per tenant.

---

## Run it

Needs Docker (for Postgres) and Node 22+.

```bash
docker compose up -d pg        # Postgres 17 on :5440
npm install
npm run build
npm run db:migrate             # applies db/migrations/*.sql
npm run db:seed                # org, namespace, tenant, principal, model, tool, grants

npm run tool:target &          # :4001 — a target for the seeded demo tool
npm run start:api &            # :3000
npm run start:worker &         # :3001 health
npm run start:scheduler &      # :3002 health
```

Then start a run. The three identity headers are not decoration: `x-tenant-ref` partitions
every table the run touches, and a tenant the caller has no grant for is a 403 rather than
an empty result.

```bash
curl -X POST localhost:3000/v1/runs \
  -H 'content-type: application/json' \
  -H 'x-caller-subject: svc:demo-client' \
  -H 'x-namespace: demo' \
  -H 'x-tenant-ref: merchant-1' \
  -d '{"agent":{"model":{"ref":"internal/echo"},"tools":["demo.echo"]},"input":"hello"}'
```

```bash
RUN=<runId from above>
H='-H x-caller-subject:svc:demo-client -H x-namespace:demo -H x-tenant-ref:merchant-1'
curl $H localhost:3000/v1/runs/$RUN                    # state, cost, step count
curl $H localhost:3000/v1/runs/$RUN/steps              # per-step detail
curl $H localhost:3000/v1/runs/$RUN/events/history     # the event log
curl $H -N localhost:3000/v1/runs/$RUN/events          # SSE; add -H 'last-event-id: 3'
curl localhost:3000/v1/ops/subsystems                  # queue depth, run states, dead letters
```

`npm run verify` runs the whole gate: lint, build, core-only build, layering rules, tests.
The end-to-end tests need the api and worker running.

---

## What is here

| Path | |
|---|---|
| `src/platform/` | Config, persistence, request context, metrics. Depends on nothing above it |
| `src/domain/` | Run engine, queue, event log, checkpoints, tool runtime, model gateway, admission. Depends on ports, never on adapters |
| `src/adapters/` | Framework adapters, model providers, sandbox. Bound to port tokens in `adapters.module.ts` |
| `src/api/` | Controllers, SSE, context middleware, error filter |
| `src/worker/` `src/scheduler/` | The two non-HTTP processes |
| `db/migrations/` | The schema, as executable history. `db/schema.sql` is the readable whole |
| `ai-docs/` | Requirements, API surface, client integrations, LLD |

### Three processes, not one

A control-plane deploy must not interrupt in-flight runs, so the api holds no run. The
scheduler is separate from the worker because its jobs are singleton-by-nature —
reclaiming another worker's expired lease on N replicas is N races where one is correct.
It elects a leader with `pg_try_advisory_lock`.

---

## The parts worth knowing before changing anything

**Fencing, not just heartbeats.** `run_queue.lease_epoch` increments on every claim, and
every durable write asserts `lease_owner = me AND lease_epoch = mine` in the same
statement. Without it a worker stalled in GC long enough to lose its lease wakes up and
writes a step into a run another worker now owns, interleaving two realities in one event
log. Heartbeats shorten that window; only fencing closes it. `test/fencing.spec.ts` proves
it with a stale lease.

**Sequence allocation, not the primary key, gives ordering.** `events` is partitioned by
`occurred_at`, so Postgres requires the partition key in the PK and `(run_id, seq)` cannot
be enforced across partitions by an index. What enforces it is
`UPDATE runs SET last_event_seq = last_event_seq + 1 ... RETURNING` inside the same
transaction as the insert — the row lock serialises allocation per run. See `db/ERD.md`.

**A cache hit and a cache miss produce identical history.** A cached tool result still
writes its invocation row and still emits `tool.completed` carrying the output. Replay
reads events, never the cache. Break this and the event log stops being a system of record.

**A non-idempotent tool left `running` after a crash is indeterminate.** The run does not
retry it and does not assume it succeeded. It says so and fails. Three lines in
`tool-runtime.service.ts`, and the difference between the durability guarantees being
honest and being a claim.

**Admission collects every rejection.** An author fixing a spec sees all the problems at
once, and an ungranted capability is refused rather than quietly filtered out.

### Layering is enforced, not documented

```
platform  ←  domain  ←  adapters
                     ←  api / worker / scheduler
```

`npm run build:core` compiles `platform` + `domain` with every adapter and controller
excluded. If a framework concept leaks into the domain, that build fails.
`npm run lint:layers` adds the rest of the rules. Both are in `npm run verify`, and both
have been checked against a deliberate violation rather than assumed to work.

---

## Model providers

Four adapters, registered in `src/adapters/adapters.module.ts`:

| Provider id | Covers | Wire shape |
|---|---|---|
| `openai-compatible` | OpenAI, **LiteLLM**, OpenRouter, vLLM, Groq, Together | `POST /chat/completions`, system prompt as a message |
| `anthropic` | Anthropic | `POST /messages`, system as a top-level field, `max_tokens` required, content is a block array |
| `google` | Gemini | `POST /models/{id}:generateContent`, `contents`/`parts`, key in a header |
| `echo` | nothing — an in-process fake | For CI and laptops, so the engine can be exercised without a vendor key |

Adding a vendor is one entry in that factory plus one row in `models`. Three of the four
share nothing but the port, which is the test that the port is the right shape.

### Using LiteLLM

A LiteLLM proxy is not a special case — it is a model row whose provider is
`openai-compatible` and whose `base_url` points at the proxy:

```sql
INSERT INTO models (org_id, ref, provider, provider_model_id, residency, base_url, credential_ref)
VALUES (:org, 'gateway/sonnet', 'openai-compatible', 'claude-sonnet-4',
        'external', 'http://litellm.internal:4000/v1', 'litellm');
```

with `MODEL_CREDENTIAL_LITELLM` in the environment. That one row reaches every vendor
LiteLLM fronts.

**What LiteLLM must not own here is routing and fallback.** §9 requires that a run which
silently switched models be diagnosable, and §16.1 requires that an agent marked
`regulated` be structurally unable to reach an external provider. If LiteLLM picks the
model, both happen inside a process whose decisions never reach our event log — the
fallback is invisible and the residency gate is bypassed by LiteLLM's own routing table.
So: LiteLLM as a transport to many vendors, yes; LiteLLM as the gateway, no. Keep
`fallback_model_id` and the residency check on our side.

### Trying a real vendor

```bash
# .env — the store also accepts a credential_ref that names an existing variable directly,
# so an established convention does not have to be copied into a second one.
TEST_LLM_KEY=...

npm run db:seed:gemini      # seeds google/gemini-2.5-flash + its capability grant
npm run start:worker        # restart so the worker picks up the new variable
```

`test/live-provider.spec.ts` runs against the real vendor and **skips itself when
`TEST_LLM_KEY` is absent**, so CI stays offline and free. Everything else runs against
local servers speaking each vendor's real wire shape; the live test is what proves those
fakes are not lying about the protocol.

### Credentials

`models.credential_ref` holds a **name**; the secret store resolves it at call time
(`MODEL_CREDENTIAL_<REF>`, a bare key or a JSON object for multi-field vendors). The value
is passed straight to the provider adapter and is never persisted, logged, or placed in
model context. `credential_grants` records the audience, scopes, on-behalf-of principal
and a jti — never the token.

Nothing is written to `process.env` around a call. Setting vendor keys on the environment
and restoring them afterwards is how one tenant's key ends up in another tenant's request
under concurrency, whichever run wrote last winning for both.

A `residency = 'external'` model that names no `base_url` and `credential_ref` is refused
by a CHECK constraint, and a missing secret fails before a request is built rather than as
a 401 mid-run.

## Two things to decide

**1. Prisma and Kysely both exist.** The runtime uses **Kysely** — the schema leans on
partitioned tables, native enums, composite foreign keys and CHECK constraints that carry
business rules, and an entity-mapping ORM fights all of them. `prisma/schema.prisma` and
`src/generated/prisma` are left in place as a modelling artifact from earlier work; they
are excluded from the build and from the layering check, and nothing at runtime imports
them. Either keep Prisma as documentation or delete it, but do not let both claim to be
the source of truth. `db/migrations/` is authoritative today.

**2. The sandbox is an HTTP egress boundary, not isolation.** `HttpEgressSandbox` bounds
what a tool can do — one outbound call, declared endpoint, deadline, broker-minted headers
— but it does not isolate the process. That is honest while every tool is an HTTP call to
a first-party service. It is not sufficient the moment agent-authored code executes. The
seam is `tools.sandbox_profile`, so moving to a container or microVM runtime is a registry
change plus one provider. See `ai-docs/client-interactions/03-coding-agent.md`.

## What it can serve

Five of §1.1's seven workload classes: autonomous tool-using agents, conversational
agents, background and multi-step workflows, human-in-the-loop, and long-running stateful
runs. **Not** coding agents (needs artifacts and real sandbox isolation) and **not** voice.

`ai-docs/STATUS.md` has the full picture per class and per consumer, with what is missing
for each.

## Not built yet

Memory tiers and the context engine (Phase 2 — pgvector is installed but unused),
artifacts, the caching layer, MCP and A2A adapters, voice, and eval-gated deployment.

## API reference

`GET /docs` — Swagger UI, served by the running API. `GET /docs/json` and `GET /docs/yaml`
for the raw OpenAPI 3 document.

The document is generated from the router and from the **Zod schemas that validate
requests**, not from a checked-in spec or a parallel set of DTO classes. A shape shown
there is the shape that is enforced, and a route cannot exist without appearing — a test
fails if any operation lacks a description.

Every tenanted call needs `x-caller-subject`, `x-namespace` and `x-tenant-ref`; the
reference declares them per operation, and correctly omits them on `/healthz`, `/metrics`
and `/v1/triggers/*`, which have no caller identity by design.
