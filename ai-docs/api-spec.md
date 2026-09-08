# General Agent Platform — API surface

Routes only. No request or response bodies. Section refs (§) point at `pwd.md`;
persistence for each resource is in `db/schema.sql`.

## Conventions

- Base path `/v1`. Protocol adapter surfaces (`/a2a`, `/.well-known`) sit outside it
  deliberately — the core runtime must compile with every adapter removed (§2.1).
- `sync` · `stream` · `async` are **delivery modes on the same route**, not separate routes.
  All are durable by default; a `sync` client that disconnects leaves the run executing and
  resumable by id (§18.4).
- `tenantRef` is a first-class run parameter, not application metadata (§5.2). It is carried
  as a header on every execution call and participates in authorization, quota and residency.
- `Idempotency-Key` on every POST that creates a run or a side effect (§4.5).
- All streaming is SSE over HTTP/2 with `Last-Event-ID` replay-then-tail (§12.1). No WebSocket
  control plane for browser clients (§20); WS appears once, server-to-server, for telephony.
- Saturation is a typed error the caller can act on, per level, per policy — queue, throttle
  or shed (§5.1). It is not a 500.

---

## 1. Control plane — agents

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/agents` | Register an agent |
| `GET` | `/v1/agents` | List agents |
| `GET` | `/v1/agents/{name}` | Read agent |
| `PUT` | `/v1/agents/{name}` | Update agent, materialising a new version |
| `DELETE` | `/v1/agents/{name}` | Deprecate and archive (§17.4) |
| `POST` | `/v1/agents/{name}/validate` | Admission dry-run; returns explicit rejections, never silent narrowing (§17.5) |
| `GET` | `/v1/agents/{name}/versions` | List immutable versions |
| `GET` | `/v1/agents/{name}/versions/{version}` | Read one materialised spec |
| `GET` | `/v1/agents/{name}/status` | Reconciler status subresource: observed state and conditions (§17.7) |
| `GET` | `/v1/agents/{name}/card` | Signed Agent Card, derived from the spec — never separately registered (§13.6) |

## 2. Control plane — deployment and rollout (§17.4, §15.5)

The gate can **refuse**. Promotion requires a completed eval run of the gate's suite for
**exactly the version being promoted** — not a recent passing run for the agent, which is
the failure where v4 ships on v3's evidence. Overrides require the gate to permit them and
are recorded with a mandatory reason (§16.4).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/agents/{name}/deployments` | Deployment history with the eval run each promotion cited |
| `GET` | `/v1/agents/{name}/gate` | Would this version promote? Answered without promoting |
| `POST` | `/v1/agents/{name}/gate` | Configure the gate: suite, minimum score, whether overrides are allowed |
| `POST` | `/v1/agents/{name}/promote` | Promote, optionally as canary or shadow; refused by a failing gate |
| `POST` | `/v1/agents/{name}/rollback` | Return to the previous version — target derived from history, not supplied |

## 3. Control plane — registries (§17.1)

### Models (§9)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/models` | List / register model refs |
| `GET` `PUT` `DELETE` | `/v1/models/{ref}` | Read / update / retire |
| `GET` | `/v1/models/{ref}/health` | Provider health as the gateway sees it |
| `GET` | `/v1/models/{ref}/capabilities` | Declared native capabilities agents defer to (§0.5) |

### Prompts (§17.2)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/prompts` | List / create prompt resource |
| `GET` | `/v1/prompts/{ref}` | Read prompt with version list |
| `GET` `POST` | `/v1/prompts/{ref}/versions` | List / publish an immutable version |
| `GET` | `/v1/prompts/{ref}/versions/{version}` | Read one version |
| `POST` | `/v1/prompts/{ref}/versions/{version}/approve` | Approve for production binding |

### Policies (§17.3)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/policies` | List / create policy resource |
| `GET` | `/v1/policies/{ref}` | Read policy with version list |
| `GET` `POST` | `/v1/policies/{ref}/versions` | List / publish an immutable version |
| `GET` | `/v1/policies/{ref}/versions/{version}` | Read one version |
| `POST` | `/v1/policies/{ref}/versions/{version}/approve` | Approve for production binding |

### Tools (§8.1)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/tools` | List / register a tool of any origin |
| `GET` `PUT` `DELETE` | `/v1/tools/{ref}` | Read / update / retire |
| `GET` | `/v1/tools/{ref}/versions` | Version history |
| `GET` | `/v1/tools/{ref}/effects` | Declared effect contract and what the runtime does with it (§8.3) |

### MCP servers (§13.1, §13.2)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/mcp/servers` | List / register. Registry id only — no inline definitions (§18.5) |
| `GET` `PUT` `DELETE` | `/v1/mcp/servers/{id}` | Read / update / retire |
| `GET` | `/v1/mcp/servers/{id}/tools` | Discovered tool definitions with pinned hashes |
| `POST` | `/v1/mcp/servers/{id}/refresh` | Re-discover; a changed definition fails closed |
| `POST` | `/v1/mcp/servers/{id}/tools/{toolName}/approve` | Re-approve a changed definition hash |
| `GET` `POST` | `/v1/mcp/servers/{id}/approvals` | List / grant tenant-scoped approval |
| `DELETE` | `/v1/mcp/servers/{id}/approvals/{approvalId}` | Revoke approval |

> No session routes. The MCP transport core is stateless as of the 2026-07-28 revision;
> there is no session lifecycle and no session affinity to expose (§13.1, §20).

### Peers (§13.6)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/peers` | List / register a peer, local or remote binding |
| `GET` `PUT` `DELETE` | `/v1/peers/{name}` | Read / update / retire |
| `POST` | `/v1/peers/{name}/verify-card` | Verify the card signature for domain assurance |
| `GET` | `/v1/peers/{name}/health` | Reachability and protocol revision |

### Speech providers (§12.3)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/speech/providers` | List / register an STT or TTS provider |
| `GET` `PUT` `DELETE` | `/v1/speech/providers/{id}` | Read / update / retire |
| `GET` | `/v1/speech/providers/{id}/capacity` | Concurrency ceiling and current utilisation |

### Triggers (§18.2)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/agents/{name}/triggers` | List / attach a trigger |
| `GET` `PUT` `DELETE` | `/v1/triggers/{id}` | Read / update / detach |
| `POST` | `/v1/triggers/{id}/enable` | Enable |
| `POST` | `/v1/triggers/{id}/disable` | Disable |
| `POST` | `/v1/triggers/{id}/test` | Fire once without arming the trigger |

## 4. Control plane — tenancy and governance (§5, §16, §17.7)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/v1/namespaces` | List / create. One namespace maps to exactly one owning team (§17.7) |
| `GET` `PUT` | `/v1/namespaces/{slug}` | Read / update |
| `GET` `POST` | `/v1/namespaces/{slug}/tenants` | List / register a consuming service's customer |
| `GET` `PUT` `DELETE` | `/v1/namespaces/{slug}/tenants/{tenantRef}` | Read / update / offboard |
| `GET` `POST` | `/v1/grants` | List / issue a capability grant, service or user (§16.2) |
| `DELETE` | `/v1/grants/{id}` | Revoke |
| `POST` | `/v1/grants/effective` | Resolve `spec ∩ service grant ∩ user grant` for a caller |
| `GET` `PUT` | `/v1/budgets` | List / set hierarchical budgets |
| `GET` | `/v1/budgets/{level}/{scopeRef}` | Read one budget with spend to date |
| `GET` `PUT` | `/v1/backpressure-policies` | List / set per-level saturation policy (§5.1) |
| `GET` | `/v1/backpressure-policies/{level}/{scopeRef}` | Read one level's policy and current pressure |
| `GET` | `/v1/admission/decisions` | Audit of approvals and rejections |
| `GET` | `/v1/credentials/grants` | Broker audit: what was minted, for whom, on whose behalf (§16.3) |

## 5. Catalog (§17.6)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/catalog` | Everything discoverable, derived from AgentSpec — no second registration system |
| `GET` | `/v1/catalog/search` | Search across agents, tools, models, prompts, servers, peers |
| `GET` | `/v1/catalog/agents` | Discoverable agents. Ephemeral agents never appear here (§18.1) |
| `GET` | `/v1/catalog/tools` | Discoverable tools with effect contracts |
| `GET` | `/v1/catalog/capabilities` | Capability index across the org |

---

## 6. Execution (§18.3, §4)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/agents/{name}/runs` | Start a run of a registered agent |
| `POST` | `/v1/runs` | Start a run from an inline spec, or a ref plus overrides (§18.1, §18.5) |
| `GET` | `/v1/runs` | List runs, filtered by thread, tenant, status, agent |
| `GET` | `/v1/runs/{id}` | Read run state — also the async polling mode (§18.4) |
| `POST` | `/v1/runs/{id}/cancel` | Cancel, with propagation to children (§13.5) |
| `POST` | `/v1/runs/{id}/fork` | Fork from a checkpoint into a new run (§4.2) |
| `POST` | `/v1/runs/{id}/resume` | Operator resume of a run stuck in `waiting` or dead-lettered |
| `GET` | `/v1/runs/{id}/events` | **SSE.** Live stream with `Last-Event-ID` replay-then-tail (§12.1) |
| `GET` | `/v1/runs/{id}/events/history` | Paged event log for replay and time-travel debugging |
| `GET` | `/v1/runs/{id}/steps` | Step list |
| `GET` | `/v1/runs/{id}/steps/{seq}` | One step |
| `GET` | `/v1/runs/{id}/tool-invocations` | Tool calls with origin, effects and authorization |
| `GET` | `/v1/runs/{id}/checkpoints` | Checkpoint list |
| `GET` | `/v1/runs/{id}/checkpoints/{checkpointId}` | One checkpoint's state |
| `GET` | `/v1/runs/{id}/interactions` | Human interactions raised by this run |
| `GET` | `/v1/runs/{id}/artifacts` | Artifacts this run produced |
| `GET` | `/v1/runs/{id}/children` | Child runs — sub-agent and peer delegations (§4.6) |
| `GET` | `/v1/runs/{id}/usage` | Token and cost accounting for this run |
| `GET` | `/v1/runs/{id}/trace` | Distributed execution graph across every MCP and A2A hop (§15.2) |
| `GET` | `/v1/runs/{id}/lineage` | Where each piece of information in the output came from (§15.3) |

## 7. Threads (§3)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/threads` | Create a thread |
| `GET` | `/v1/threads` | List threads |
| `GET` | `/v1/threads/{id}` | Read thread |
| `PATCH` | `/v1/threads/{id}` | Update metadata |
| `POST` | `/v1/threads/{id}/runs` | Next conversational turn — a plain POST, per §12.1 |
| `GET` | `/v1/threads/{id}/runs` | Runs on this thread |
| `GET` | `/v1/threads/{id}/events` | **SSE.** Thread-level stream spanning consecutive runs |
| `GET` | `/v1/threads/{id}/messages` | Transcript of what the user actually received (§6.3) |
| `GET` | `/v1/threads/{id}/artifacts` | Thread workspace |
| `GET` | `/v1/threads/{id}/memory` | Thread-scoped memory |
| `POST` | `/v1/threads/{id}/archive` | Archive |
| `DELETE` | `/v1/threads/{id}` | Delete thread and its thread-scoped state |

## 8. Interactions — human-in-the-loop (§14)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/interactions` | Responder inbox, filtered by authorization |
| `GET` | `/v1/interactions/{id}` | Read one interaction, channel-independent |
| `POST` | `/v1/interactions/{id}/respond` | Answer it; the run resumes |
| `POST` | `/v1/interactions/{id}/cancel` | Withdraw the request |
| `POST` | `/v1/interactions/{id}/reassign` | Route up the delegation chain to someone who can answer (§14.3) |
| `GET` | `/v1/interactions/stream` | **SSE.** Live inbox for a responder |

## 9. Memory (§6)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/memory` | Store a record at a declared scope and tier |
| `GET` | `/v1/memory` | List by scope, tier, agent, thread |
| `POST` | `/v1/memory/search` | Relevance retrieval across scopes |
| `GET` | `/v1/memory/{id}` | Read one record with its provenance (§6.4) |
| `PATCH` | `/v1/memory/{id}` | Update |
| `DELETE` | `/v1/memory/{id}` | Delete |
| `DELETE` | `/v1/memory` | Bulk delete by scope — the erasure path |
| `POST` | `/v1/memory/consolidate` | Trigger summarisation, re-ranking, decay, merge out of band |
| `GET` | `/v1/memory/{id}/lineage` | Trace a record back to its sources |

## 9b. Skills and knowledge (§6.1, §17.5)

Two surfaces that ship together and are deliberately not one. A **knowledge collection**
is an authored corpus retrieved by the same embedding contract as semantic memory; a
**skill** is versioned procedural content that may carry tools and collections with it.

Note the absent verbs: there is no `PUT /v1/skills/{name}` and no `PATCH`. A skill version
is immutable, so editing one is publishing the next. An agent pins the version it was
admitted against, so a publish never changes what a running agent does — which is what
keeps a skill's tools inside the admission decision that approved them (§17.5).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/skills` | List skills in the namespace with their latest active version |
| `POST` | `/v1/skills` | Publish a new immutable version (v1 if new) |
| `GET` | `/v1/skills/{name}/versions` | Version history with spec hashes and status |
| `DELETE` | `/v1/skills/{name}/versions/{version}` | Deprecate — unselectable by name, existing pins keep working |
| `GET` | `/v1/knowledge/collections` | List collections with document counts |
| `POST` | `/v1/knowledge/collections` | Create a collection, recording the embedder that will index it |
| `GET` | `/v1/knowledge/collections/{id}/documents` | List ingested documents |
| `POST` | `/v1/knowledge/collections/{id}/documents` | Ingest — chunk, embed, index; idempotent on content |
| `DELETE` | `/v1/knowledge/collections/{id}/documents/{documentId}` | Delete a document and its chunks |
| `GET` | `/v1/knowledge/collections/{id}/search` | Retrieval without running an agent — separates "bad retrieval" from "bad reasoning" |

## 10. Artifacts (§11.2)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/artifacts` | Create metadata and obtain an upload target |
| `GET` | `/v1/artifacts` | List by thread, run, tenant |
| `GET` | `/v1/artifacts/{id}` | Read metadata, hash and reference |
| `GET` | `/v1/artifacts/{id}/content` | Download bytes |
| `PUT` | `/v1/artifacts/{id}/content` | Upload bytes |
| `GET` | `/v1/artifacts/{id}/versions` | Version chain |
| `GET` | `/v1/artifacts/{id}/lineage` | Producing run and derived-from edges |
| `POST` | `/v1/artifacts/{id}/legal-hold` | Place hold — survives TTL expiry |
| `DELETE` | `/v1/artifacts/{id}/legal-hold` | Release hold |
| `DELETE` | `/v1/artifacts/{id}` | Delete, refused while a hold stands |

## 11. Observability, lineage and evaluation (§15)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/traces/{traceId}` | One distributed trace across agents, tools, servers and peers |
| `GET` | `/v1/lineage/{nodeKind}/{nodeId}` | Traverse provenance from any node |
| `GET` | `/v1/events` | Cross-run event query, access-controlled by tenant |
| `POST` | `/v1/replay` | Replay a run or an archived corpus against the current event model (§0.2) |
| `GET` | `/v1/usage` | Usage and cost by org, namespace, tenant, agent, model |
| `GET` | `/v1/usage/summary` | Rolled-up cost attribution |
| `GET` `POST` | `/v1/feedback` | Read / submit user feedback and human corrections |
| `GET` | `/v1/evals/mechanisms` | **§0.5's ledger** — every compensating mechanism and whether an eval justifies it |
| `GET` `POST` | `/v1/evals/suites` | List / create eval suites |
| `GET` `PUT` | `/v1/evals/suites/{ref}` | Read / replace a suite and all its cases |
| `GET` | `/v1/evals/suites/{ref}/cases` | List cases |
| `POST` | `/v1/evals/runs` | Run a suite against a version; `compareMechanism` runs the mechanism-off arm too (§0.5) |
| `GET` | `/v1/evals/runs` | Run history for a suite, with scores, verdicts, latency and cost |
| `GET` | `/v1/evals/runs/{id}` | Read result, verdict and the other A/B arm |
| `GET` | `/v1/evals/runs/{id}/results` | Per-case scores and why each passed or failed |

---

## 12. Trigger ingress (§18.2)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/triggers/webhooks/{path}` | External webhook → run |
| `POST` | `/v1/triggers/events` | Internal event bus bridge → run |
| `POST` | `/v1/triggers/callbacks/{token}` | External callback resuming a waiting run |

## 13. A2A peer surface (§13.4, §13.6)

Outside `/v1`: this is a protocol adapter, not the platform's own API. It owns **no
state** — `message/send` creates a run, `tasks/get` projects a run row, and the stream is
the same SSE endpoint every other consumer uses. §13.4's requirement that all active
streams for a task see the same events in the same order, and that task lifecycle is
independent of stream lifecycle, falls out of the append-only event log with per-run
sequence numbers rather than from anything written here.

Callers authenticate as a **registered peer** (`x-a2a-peer`). What that peer may assert
about tenancy is governed by its `inbound_trust` (§15.4): `self` — the default — scopes
the run to `peer:<name>` no matter what the request claims.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/.well-known/agent-card.json` | Discovery. Describes the runtime; `?agent=` returns one agent's card |
| `GET` | `/a2a/v1/agents/{name}/card` | Signed card for one exposed agent, derived from its spec (§13.6) |
| `POST` | `/a2a/v1` | JSON-RPC: `message/send`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, `tasks/pushNotificationConfig/set` |
| `GET` | `/a2a/v1/tasks/{taskId}/stream` | **SSE.** Replay-then-tail with `Last-Event-ID` |

## 14. Voice media plane (§12.2)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/voice/sessions` | Open a session and start a `relaxed`-tier run |
| `GET` | `/v1/voice/sessions/{id}` | Session state |
| `POST` | `/v1/voice/sessions/{id}/offer` | WebRTC SDP offer/answer exchange |
| `POST` | `/v1/voice/sessions/{id}/ice` | ICE candidate exchange |
| `GET` | `/v1/voice/sessions/{id}/events` | **SSE.** Control events; media never crosses this path |
| `POST` | `/v1/voice/sessions/{id}/end` | End session |
| `WS` | `/voice/telephony/{sessionId}` | **Server-to-server only.** Telephony media, μ-law 8 kHz |

## 15. Operations (§0.8, §15.4)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness |
| `GET` | `/metrics` | Prometheus scrape |
| `GET` | `/v1/ops/subsystems` | Platform self-observability: API, workers, scheduler, queues, gateway, memory, artifacts, cache, adapters, voice |
| `GET` | `/v1/ops/queue` | Queue depth, lease age, starvation signals |
| `GET` | `/v1/ops/workers` | Worker inventory, leases held, heartbeats |
| `GET` | `/v1/ops/dead-letters` | Dead-letter inventory |
| `GET` | `/v1/ops/dead-letters/{id}` | One dead-lettered run with its failure history |
| `POST` | `/v1/ops/dead-letters/{id}/replay` | Replay as a new run |
| `POST` | `/v1/ops/dead-letters/{id}/acknowledge` | Acknowledge without replay |
| `GET` | `/v1/ops/event-schemas` | Registered event schema versions and their upcasters (§0.2) |

---

## Deliberately absent

- **No MCP session routes.** The protocol core is stateless; there is no session lifecycle or
  affinity to expose (§13.1, §20).
- **No WebSocket control plane for browser clients.** SSE serves internal clients, MCP
  interactions and A2A streaming alike. WS appears once, server-to-server, for telephony (§12.1).
- **No inline MCP server definitions on any route.** Servers are referenced by registry id, or
  hash pinning and tenant approval are bypassed (§18.5).
- **No business-domain routes.** No campaign scheduling, no payment or loan endpoints. The
  platform provides the trigger primitive; domain scheduling stays in the consuming service
  (§18.2, §20).
- **No cache-management routes.** Caching is declared per tool contract, never operated by hand,
  and never appears in the replay path (§10).
- **No separate durability routes.** Mode is delivery, not durability — every execution route is
  durable by default (§18.4).
