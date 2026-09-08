# Client-readiness manual test cases

**Purpose:** A release checklist for manually verifying this currently vibe-coded
platform before any client receives access. Automated tests are useful evidence, but
they do not replace these checks against a running API, worker, scheduler, Postgres,
and (where applicable) real provider or external service.

**Release rule:** Every P0 case must pass. Any failed P0, unexplained data leak,
credential exposure, duplicate side effect, lost run, or misleading success response
blocks client exposure. Record the build/commit, environment, tester, timestamp, and
evidence for every executed case.

## Test setup

Use an isolated database and at least two tenants:

- `merchant-1` and `merchant-2` in the same namespace;
- two caller subjects with different grants;
- one registered agent using `internal/echo`;
- one deterministic tool target from `npm run tool:target`;
- API, worker, scheduler, and Postgres running separately;
- a test webhook receiver and, if testing integrations, disposable MCP/A2A endpoints.

Before testing, run `npm run verify`, apply migrations and seed data, and confirm that
secrets are test-only. Do not use production customer data or production credentials.

## P0 — must pass before exposure

### Startup, configuration, and basic contract

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-01 | Clean startup | Start Postgres, migrate, seed, then start API, worker, and scheduler. Restart each process once. | Processes start without hidden manual setup; `/healthz` is live and `/readyz` is ready only when required dependencies are available. |
| P0-02 | Configuration failure | Remove/invalidly set a required environment value for each process and start it. | Process fails clearly at startup; no partially ready service or silently unsafe default. |
| P0-03 | Basic request contract | Create a model-only run with the documented identity headers and `internal/echo`; inspect the response and poll the run. | Request validation errors are actionable; accepted response contains a stable run ID and status; the run reaches a terminal state. |
| P0-04 | Unknown resources | Request a nonexistent run, thread, artifact, interaction, collection, skill, and peer. | Consistent 404-style platform error; no stack trace, secret, or misleading empty success. |
| P0-05 | Malformed input | Send missing headers, invalid JSON, unknown fields, empty input, oversized input, and invalid enum values. | Consistent 4xx responses; no process crash; validation does not silently discard unsafe fields. |

### Identity, authorization, and tenant isolation

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-06 | Required identity headers | Omit or alter `x-caller-subject`, `x-namespace`, and `x-tenant-ref` independently on execution and read requests. | Missing/invalid identity is rejected; no request falls back to a default tenant or namespace. |
| P0-07 | Grant enforcement | Use a caller without a namespace, tenant, model, or tool grant to create a run. | Request is rejected before execution, with all applicable admission reasons; no run or side effect is created. |
| P0-08 | Cross-tenant reads | Create runs, events, artifacts, memory, threads, feedback, and knowledge in `merchant-1`; read them as `merchant-2`. | Resources are not discoverable or readable. Verify list, get, search, stream, trace, and error behavior. |
| P0-09 | Cross-tenant writes and IDs | Replay a valid `merchant-1` ID, idempotency key, artifact ID, interaction ID, and thread ID from `merchant-2`. | Operation is denied without mutating the original resource. IDs and timing do not reveal sensitive existence information. |
| P0-10 | Revocation takes effect | Revoke a grant after an initial successful request; attempt a new run/tool/MCP/memory operation. | New operation is denied. Existing durable state follows the documented policy and does not gain new capabilities. |
| P0-11 | Secret handling | Run a real-provider or MCP-backed request, then inspect API/worker logs, events, traces, errors, DB rows, and client responses. | Tokens, API keys, broker headers, and raw credentials never appear in persisted data, logs, traces, or model context. |

### Durable runs, tools, and delivery modes

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-12 | Model-only run | Submit a model-only run and poll it until completion. | Status transitions are valid and monotonic; output, usage, cost, timestamps, and event history are present and coherent. |
| P0-13 | Tool run | Submit a run that calls the seeded tool; inspect the target receiver and run detail. | Tool is called exactly as authorized, through the declared sandbox, with the expected input and no leaked credential. |
| P0-14 | Idempotent create | Submit the same POST with the same `Idempotency-Key` concurrently and then retry after a timeout. | Exactly one durable run and one external side effect; retries return the original result or a documented equivalent. |
| P0-15 | Key collision | Reuse an idempotency key with a materially different body or tenant. | Request is rejected as a conflict; the first request is not changed and the second body is not executed. |
| P0-16 | Disconnect durability | Start a run in sync/stream/async mode, disconnect the client, then poll by ID. | Run continues durably; client can recover the final state and output without restarting work. |
| P0-17 | Cancel | Start a slow run, cancel it, and retry cancellation. Also cancel during a tool call if possible. | Run becomes cancelled once, stops future work, propagates according to policy, and repeated cancel is safe. |
| P0-18 | Worker restart and lease recovery | Stop the worker during a queued/run step, restart it, and inspect events, checkpoints, and tool calls. | Work is reclaimed safely; no duplicate non-idempotent side effect, split history, stale-worker write, or permanently lost run. |
| P0-19 | Failure and retry | Make the model/tool endpoint fail, timeout, and return malformed data. | Failure is classified correctly, retry policy is bounded, terminal status is honest, and no partial success is reported. |
| P0-20 | Effect contract | Exercise idempotent, compensatable, and non-idempotent tools; crash/retry the worker around each call. | Runtime behavior matches the declared effect contract; an indeterminate non-idempotent call is not silently repeated or marked successful. |

### Streaming and event history

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-21 | Live SSE | Subscribe to `/v1/runs/{id}/events` before and during a run. | Correct `Content-Type`, event names/data/IDs, ordering, terminal event, and connection behavior. No cross-run or cross-tenant events. |
| P0-22 | SSE resume | Read through event N, disconnect, reconnect with `Last-Event-ID: N`, and repeat after completion. | Only later events are replayed, then live events tail; no gaps, duplicates, or replay of another run. |
| P0-23 | History consistency | Compare SSE events, history endpoint, run status, steps, checkpoints, and usage after success and failure. | Same run identity and sequence; history is complete and ordered; pagination/cursors do not skip or duplicate records. |
| P0-24 | Slow consumer | Consume SSE slowly and reconnect repeatedly. | Backpressure is bounded and reported as a typed, actionable response; API and worker remain healthy. |

### Threads, HITL, and callbacks

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-25 | Multi-turn thread | Create a thread, make two turns, read runs/messages, then archive it. | Each turn has its own run; transcript contains what the client received; archive preserves required history and prevents unintended new work. |
| P0-26 | Human approval | Start a run requiring approval; list/read the interaction; approve it. | Run enters waiting, interaction is visible only to an authorized responder, approval resumes the intended step exactly once. |
| P0-27 | Denial, expiry, duplicate answer | Deny or expire an interaction, then submit two responses/cancel attempts. | Denied/expired action never executes; terminal interaction cannot be answered twice or resurrect the run. |
| P0-28 | Webhook delivery | Fire a registered webhook, inspect the created run and receiver, force receiver failure, then allow recovery. | Trigger identity and payload are validated; delivery is outboxed, retried safely, and dead-lettered with enough diagnosis when exhausted. |

### Data lifecycle and retrieval

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-29 | Artifact bytes and versions | Create/download an artifact, upload a new version, list versions, and compare hashes/bytes. | Exact bytes round-trip; version chain and content-addressing are correct; tenant boundaries hold. |
| P0-30 | Artifact deletion and legal hold | Place/release legal hold and attempt delete/GC in each state. | Held content cannot be deleted or collected; released content follows retention policy; client receives truthful state. |
| P0-31 | Memory lifecycle | Store, search, read provenance/lineage, consolidate, expire, and delete memory in one tenant. | Scope/tier/trust filters work; lineage remains traversable; deletion removes retrieval; another tenant cannot recall it. |
| P0-32 | Knowledge ingestion | Create a collection, ingest a document twice, search by meaning, delete it, and search again. | Duplicate ingestion is idempotent; relevant results include provenance; deletion removes chunks/results; empty or invalid documents fail clearly. |
| P0-33 | Skills and pinning | Publish two skill versions, pin/use the first, deprecate it, and publish another. | Immutable versions stay unchanged; name resolution follows active-version rules; existing pins remain deterministic; skill capabilities cannot bypass grants. |

### External protocols and sandbox

| ID | Test | Steps | Expected result |
|---|---|---|---|
| P0-34 | Provider wire compatibility | Run a representative request through each configured provider adapter or approved fake; include tool calling and token usage. | Wire shape, system prompt, tool schema, response parsing, timeout, and usage accounting are correct for each provider. |
| P0-35 | Residency and fallback | Configure an external fallback and a regulated agent; induce primary failure. | Fallback is visible/auditable; regulated agents never reach external providers; missing credentials fail before a vendor request. |
| P0-36 | MCP approval and pinning | Register/discover an MCP server, call before approval, approve tenant access, change its tool definition, refresh, and re-approve. | Calls are denied before approval; broker headers are scoped; changed definitions fail closed until explicitly approved. |
| P0-37 | Sandbox boundaries | Exercise HTTP egress and container profiles with disallowed endpoint, timeout, filesystem escape, network access, and unavailable runtime. | Declared profile is enforced; unsafe/unknown profile fails closed; no host or artifact-root escape; errors are actionable. |
| P0-38 | A2A peer security | Verify an exposed agent card, register a remote peer over HTTPS, dispatch/cancel/stream a task, and try a modified card/plaintext endpoint. | Signature and endpoint checks fail closed; task lifecycle maps cleanly to the run; peer data and memory remain isolated. |

## P1 — required for a dependable pilot

| ID | Test | Expected result |
|---|---|---|
| P1-01 | Concurrent load | Run parallel tenants, threads, streams, tool calls, and retries at expected pilot volume. No starvation, event interleaving, unbounded memory, or tenant mix-up. |
| P1-02 | Backpressure | Apply queue/throttle/shed policies and exceed each configured bound. Typed saturation response matches policy and recovers when pressure drops. |
| P1-03 | Scheduler | Run a cron trigger across a boundary, restart scheduler, and run multiple scheduler instances. One intended firing, no duplicate delivery, and leader recovery. |
| P1-04 | Observability | Inspect metrics, traces, analytics, feedback, lineage, and the UI for a complete successful and failed run. Values reconcile with API data and contain no secrets. |
| P1-05 | Database recovery | Take a backup, restore to a clean database, migrate, and replay representative history. Required data and event upcasting survive restore. |
| P1-06 | Client SDK behavior | Test client timeout, retry, cancellation, JSON parsing, SSE reconnect, pagination, and error mapping against real responses. SDK never duplicates side effects or treats a durable async run as failed merely because the connection closed. |
| P1-07 | Resource limits | Exercise max body, artifact, event, step, memory, concurrency, and timeout limits. Limits are enforced consistently and documented responses are returned. |
| P1-08 | Browser/API hygiene | Check CORS, security headers, content types, cache headers, request-size handling, and UI access policy from an allowed and disallowed origin. |

## Release evidence and sign-off

For each case, record:

```text
Case:
Build/commit:
Environment:
Tester/date:
Request or scenario:
Observed result:
Evidence (run ID, event ID, trace ID, screenshot, log/query):
Pass / Fail / Blocked:
Defect link and owner:
```

Before handing credentials to a client, attach the completed checklist, `npm run verify`
output, database migration/backup confirmation, secret-scan result, load-test summary,
and an explicit owner for P0 failures. The current status document identifies important
limitations—especially hardened sandboxing, row-level security, budgets, progressive
deployment, and voice—so client promises must be limited to capabilities that passed
this checklist and are actually exposed by the running API.

## Scope sanity check

`ai-docs/api-spec.md` describes a larger future API than the controllers currently expose.
Before publishing client documentation, compare every promised route with the running
OpenAPI/route list and remove or mark unimplemented routes. In particular, manually
verify that any claimed deployment, model, tool, prompt/policy, budget, catalog, replay,
voice, or advanced artifact route really exists in the deployed build.
