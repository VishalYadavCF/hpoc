# 01 · `ap-executor` — the ephemeral agent node

**Service:** `ap-executor`, the Relay workflow executor.
**Consumer:** the `ai-agent` custom node (`src/custom-nodes/ai-agent`, ~3.5k LOC TS).
**Class:** §1.1 #1, autonomous tool-using · **Lifetime:** ephemeral (§18.1) · **Durability:** strict.

## What it does today

A workflow author drops an **AI Agent** node into a Relay workflow and configures it inline:
prompt, provider, model, optional system prompt, optional JSON response schema, a list of piece
tools with per-field modes (`agent` / `fixed` / `leave_empty`), and a map of MCP servers.

At run time the node builds a `deepagents` graph, calls `invoke()` once, and returns an envelope:

```
{ text, toolCalls[], stopReason, steps, provider, model, usage, toolErrors[], trace?, structured? }
```

Everything is in memory. `RunRegistryService` holds `running | succeeded | failed` in a pinned
in-process cache; `POST /api/v1/execute/:nodeName` returns the envelope synchronously, or `202
{runId}` with a later callback to Conductor or WorkflowSvc. **A pod restart loses every in-flight
run.** That is the gap this integration closes.

## Why it is the ephemeral case, and must stay one

The node's configuration lives in the workflow definition, which Relay already versions. Forcing
registration would mean every workflow-node edit becomes a platform API call, and §0.6's
"target time-to-first-working-agent: under one day" would be dead on arrival — the author would
have to register an agent before dragging a node onto a canvas.

So: **inline spec, `POST /v1/runs`, no registration.** Both lifetimes produce an `AgentVersion`;
this one is anonymous and content-addressed so runs stay replayable (§18.1).

## Integration sequence

```
Relay workflow step
      │
      ▼
ap-executor ExecutionService                        (already resolves credentials at "step 3.5")
      │  POST /v1/runs
      │    Idempotency-Key: <conductorTaskId>
      │    X-Tenant-Ref: merchant_<id>
      │    mode: sync | async
      ▼
Agent Platform ── admission (§17.5) ── AgentVersion by spec_hash ── Run ── queue
      │
      ├─ sync   : holds the HTTP response, streams nothing, returns the envelope
      └─ async  : 202 + runId; delivers to the configured webhook on completion
```

| Step | Route | Notes |
|---|---|---|
| 1 | `POST /v1/runs` | Inline spec + input. `Idempotency-Key` is the Conductor task id, so a Conductor retry does not double-charge or double-execute (§4.5) |
| 2 | *(platform)* | Admission (§17.5) intersects the inline spec against the caller's grants. A spec naming an ungranted tool is **rejected**, not silently filtered |
| 3 | `GET /v1/runs/{id}` | The async polling mode. Replaces `GET /api/v1/runs/:runId` against the in-memory registry |
| 4 | *(webhook)* | Completion callback. Replaces `conductor-callback.dispatcher.ts` / `workflowsvc-callback.dispatcher.ts` |
| — | `GET /v1/runs/{id}/events` | Available but unused: a workflow step has no UI to stream into. Useful for debugging a stuck node |

### The spec-hash cardinality question — already answered by the schema

§18.5 says to track distinct inline spec hashes per calling service, because rising cardinality
means either the caller should register or **the caller is interpolating variable content into the
system prompt** — a prompt-injection path and a cache-defeating one (§10).

ap-executor will legitimately produce one distinct spec per configured workflow node, which is a
large but *bounded* set that changes only when an author edits a node. The schema already handles
it: `agent_versions` has `UNIQUE (org_id, spec_hash)`, so the same node config reused across a
thousand workflow runs resolves to **one** `AgentVersion` row and one prompt-cache key.

What must be watched is the derivative: cardinality growing with *run count* rather than with
*edit count* means an author is interpolating step output into `systemPrompt` instead of passing it
as `input`. That is the §18.5 alarm, and `admission_decisions (caller_principal_id, spec_hash,
decided_at)` is the index that detects it.

## What the platform takes over

| Today, in the node | Becomes |
|---|---|
| `providerRegistry` + 8 provider strategies | **Model gateway** (§9) — plus routing, fallback with the fallback recorded in the event log, cost accounting per merchant, residency enforcement |
| `RunRegistryService` (in-memory, `running\|succeeded\|failed`) | **`runs` table + state machine** (§4.1). Survives pod restart; a dead worker's lease expires and the run returns to the queue |
| `AgentTracer` (`full` / `summary` / `off`) | **Event log** (§15.1) with `schema_version`, trace/span/causation ids. Trace level becomes a redaction policy, not a data-loss switch |
| `AGENT_RECURSION_LIMIT = 100` | `agent_versions.max_steps` (§19 `limits`) |
| `stopReason: 'timeout'` — declared but unreachable | `runs.deadline_at` + `step_timeout_ms`. The platform owns the timer the piece never had |
| Callback dispatchers | Webhook delivery mode (§18.4) with the transactional outbox behind it (§4.5) |

## What the node keeps

- **The `deepagents` graph.** §2.1 puts the reasoning loop in the framework layer, below the
  platform. The node stays the framework adapter.
- **Piece-tool field modes** (`agent` / `fixed` / `leave_empty`). This is workflow-authoring
  semantics, not a platform concept.
- **The recursion guard.** `assertToolTargetAllowed()` and the `x-agent-depth` header defend against
  a *Relay-specific* re-entrancy: a `litellm` provider whose `baseUrl` points back at ap-executor
  re-enters the agent without ever naming `ai-agent` in a tool config. The platform's §4.6 depth
  limit and cycle detection do not see that path, because it is not a platform delegation. **Keep
  both.**

## Effect contracts

> **Corrected 2026-09-10.** This section originally said contracts are "declared per piece
> action at registration", which assumed a registration step that does not exist. The node
> lets a workflow author pick any piece and action inline, with no registration — and
> `AgentSpec.tools` was refs-only, so there was no path for it at all. That made the
> ephemeral path unusable by the consumer it was designed for.
>
> Closed by **tool templates** (§18.5, migration 0028). An operator registers one
> `relay.piece` template — fixed origin, path prefix, method set, and the effect contract —
> and grants it. The node then defines tools inline against it:
>
> ```json
> { "template": "relay.piece",
>   "name": "piece.slack_send_message",
>   "description": "Send a Slack message",
>   "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
>   "pathTemplate": "/v1/pieces/slack/send-message",
>   "fixedArgs": { "channel": "#ops-alerts" } }
> ```
>
> The spec supplies the SHAPE; the template supplies the CONTRACT. A caller cannot declare
> its own effects — a payment tool self-declared `readOnly` would skip its approval gate,
> be cached, and lose its idempotency key.
>
> `fixedArgs` is the `fixed` field mode: bound after the model answers and **stripped from
> the schema the model sees**, so a pinned value cannot be argued with. `agent` mode is a
> field left in the schema; `leave_empty` is a field omitted from both.
>
> Identical definitions are content-addressed onto one tool row, so a workflow running ten
> thousand times does not produce ten thousand catalogue entries.

The remaining registered-tool contracts are unchanged:

```yaml
- ref: catalog.pieces.list      # discovery
  effects: [readOnly, cacheable]
  cache: { ttl: 300s, scope: org }

- ref: http.request.get
  effects: [readOnly]

- ref: <any piece action declared async>
  # not registrable as a tool at all — see below
```

The node's existing guard already refuses async-declared actions as tools, for a reason worth
lifting into the platform's tool registry: *a tool call reads the response body, and an async action
answers `202 {runId}`, so the model receives `{"runId":"..."}` as the tool's result and treats it as
the answer.* There is no callback address for a tool call and nothing to wait on. In platform terms
that is not an effect class — it is a registration-time rejection, and `tools.origin` plus admission
is where it belongs.

## Sandbox

The node today denies `deepagents`' filesystem tools by default (`mode: 'deny'` on `/**`), because
`FilesystemMiddleware` is required and cannot be excluded from the tool list. That is the weakest
form of §0.4 — an in-process deny-list, not an isolation boundary.

For this consumer it is arguably sufficient: tools are HTTP calls to Relay pieces, and no
agent-authored code executes. **It is not sufficient for consumer 03**, and §0.4 requires *one*
boundary for all agent types. Decision deferred to `03-coding-agent.md`, which is where it bites.

## Identity and the missing human

§0.1 requires every action to record which human authorized it, through which chain of agents. For
this consumer that question has an uncomfortable answer: **a scheduled Relay workflow has no human
present at run time.**

The honest chain is:

```
authorizing_human_id  = the author who published this workflow version
caller_principal_id   = ap-executor's service identity
on_behalf_of          = null   (no interactive user)
tenant_ref            = merchant_<id>
```

This must be explicit, not omitted. A null `on_behalf_of` with a populated `authorizing_human_id`
is a *different* security posture from an interactive run, and §16.2's capability intersection has
to resolve against the publishing author's entitlements at publish time, not at run time —
otherwise an author who loses access keeps their workflows running against tools they can no longer
reach. **Open question, listed below.**

Today the merchant is smuggled through `projectId = merchant_<id>` and decoded with
`merchantIdFromProjectId()`. §5.2 makes `tenantRef` a first-class parameter; the migration touches
every tool loopback call, which is why §0.6 puts tenant columns in Phase 1.

## Failure behaviour, before and after

| Failure | Today | After |
|---|---|---|
| Pod restart mid-run | Run lost. Conductor task hangs to its own timeout | Lease expires, run returns to queue, resumes from last checkpoint (§4.4) |
| Model provider 5xx | Propagates as a node failure | Gateway fails over, **records the fallback in the event log** so the run is diagnosable (§9) |
| Recursion limit hit | `GraphRecursionError` → `stopReason: 'recursion_limit'` | Same, now a persisted terminal event |
| Schema violation | Throws `AgentRunError` carrying `partialOutput` | Same envelope, plus the run and its cost survive as rows. `partialOutput` was the right call and should stay |
| MCP server mutates a tool definition | Undetected | Fails closed; requires re-approval (§13.2) |

## Migration delta

**Deletes:** `RunRegistryService`, both callback dispatchers, the async execution service,
`AGENT_RECURSION_LIMIT` as a piece constant.
**Gains:** durability, replay, cost attribution per merchant, MCP definition pinning, residency
enforcement, dead-letter visibility.
**Breaks:** `projectId`-encoded tenancy; every tool loopback call carries `tenantRef` instead.
**Unchanged:** the node's props, the envelope shape, the `deepagents` graph, the recursion guard.

## Open questions

1. **Whose entitlements govern a scheduled run?** Publish-time author, or run-time service
   identity? §16.2 is unimplementable for this consumer until settled. (Also Appendix A #6.)
2. **Does `mode: sync` hold an HTTP connection for the full run?** A `deepagents` loop with tools can
   exceed a load balancer's idle timeout. §18.4 says a disconnected `sync` client leaves the run
   executing — ap-executor needs to poll or accept the callback rather than assume the response
   arrives.
3. **Trace level vs. redaction policy.** Today `full` puts prompts and tool payloads into Conductor
   task output. Under §16.4 that becomes a redaction policy on a persisted event stream — which
   changes who can see what, and needs a decision per merchant, not per node.
