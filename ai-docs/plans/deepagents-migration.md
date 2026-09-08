# Plan — stop reinventing, run on DeepAgents

> **Status: done (2026-09-09).** All eleven phases landed, one commit each, from
> `13889ce` to `HEAD`. Three things went differently from the plan and are recorded in
> `ai-docs/decisions/0002-the-framework-drives-the-loop.md`:
>
> 1. **Open question 2 answered: the port stays.** `tsconfig.core.json` compiles
>    `src/platform` + `src/domain` with `src/adapters` excluded, so §2.1's "core compiles
>    with adapters removed" is enforced by the build. Dropping the port would break
>    `npm run build:core`.
> 2. **Phase 6 reversed.** Sub-agents did NOT replace `pipeline.adapter.ts`. DeepAgents'
>    sub-agents run in-process; ours are separate runs with their own policy, budget and
>    lifecycle (§13.3). Both are offered; the pipeline adapter stays as the only
>    deterministic orchestrator.
> 3. **Phase 9 partially declined.** `BaseSandbox` is not wired — it would grant shell
>    execution that does not exist today, which is a capability increase rather than a
>    free win.
>
> Seven defects surfaced along the way; the ADR lists them. The one worth repeating here:
> the api and worker on `:3000` were still running pre-migration binaries, so every
> HTTP-driven test had been passing against the OLD run loop. Restarting them turned a
> green suite into eight failures, three of which were real bugs.


## The decision

**DeepAgents runs the agent. Every time it asks "where do I store this?", we answer
"Postgres."**

We keep the platform (tenancy, budgets, effect contracts, evals, replay). We delete
our hand-rolled copies of things DeepAgents already does.

## Why this is possible

DeepAgents and LangGraph expose abstract base classes meant to be swapped:
`BaseCheckpointSaver`, `BaseStore`, `BaseCache`, `BaseSandbox`, `BackendProtocol`.

ap-executor has no checkpointing only because it has no database. We have one.
Swapping the storage is the entire trick.

## The architecture

```
  PLATFORM (outer — ours)              DEEPAGENTS (inner — theirs)
  ─────────────────────────            ────────────────────────────
  run created
  admission + capability check
  budget check
  lease acquired
        │
        ├─ build the agent ──────────> createDeepAgent({
        │                                model:       our BaseChatModel wrapper
        │                                tools:       our tools
        │                                checkpointer: PostgresCheckpointSaver
        │                                store:        PostgresStore
        │                                middleware:   skills + memory (Postgres)
        │                                permissions:  from our policy
        │                              })
        │
        ├─ run it ───────────────────>  .invoke(input, { callbacks: [tracer] })
        │                                     │
        │   <── every tool call ──────────────┤   runs OUR code
        │   <── every LLM event ──────────────┤   via callbacks
        │   <── every checkpoint ─────────────┘   into OUR Postgres
        │
        └─ lease released, cost recorded, events written
```

## The key design call: we own the tools, not the loop

We do **not** need to intercept DeepAgents' reasoning loop.

The tool functions we hand to `createDeepAgent` are **our functions**. When the model
calls a tool, our code runs. So our effect contracts, sandbox, idempotency keys and
step recording all still happen — inside their loop.

```
  model says "call relay.workflow.create"
        │
        ▼
  our tool function runs:
     - check the effect contract
     - check the budget
     - run it in the sandbox
     - record a step + a tool_invocation row
     - return the result
        │
        ▼
  deepagents continues reasoning
```

This is why the migration is tractable. We give up the *loop*, not the *control*.

## Phases

Each phase ships on its own and leaves the suite green.

---

### Phase 0 — add the packages, prove the seam

Add, matching ap-executor's pinned versions:

```
@langchain/openai        1.5.5
@langchain/anthropic     1.5.2
@langchain/google-genai  2.2.0
@langchain/mcp-adapters  1.1.3
```

Write one throwaway spike: `createDeepAgent` with `FakeChatModel` and one tool.
Assert it loops and calls the tool. Nothing wired into the platform.

**Breaks:** nothing.

---

### Phase 1 — providers

Replace our hand-written provider layer with `BaseChatModel`.

| Delete | LOC | Replace with |
|---|---|---|
| `openai-compatible.provider.ts` (incl. hand-written SSE) | 174 | `ChatOpenAI` |
| `anthropic.provider.ts` | 85 | `ChatAnthropic` |
| `google.provider.ts` | 98 | `ChatGoogleGenerativeAI` |
| `echo.provider.ts` | 48 | `FakeChatModel` |

**Keep** inside `ModelGateway`: residency gate, cost ledger, budget check, fallback,
cache. Those wrap the model; they are not the model.

**This is the first phase where the real API key matters.** Our SSE parser has never
been tested against a live vendor. `ChatOpenAI` has been.

**Breaks:** `model-streaming.spec.ts` (13 tests), `providers.spec.ts` (9 tests).
Both get rewritten against `BaseChatModel`.

---

### Phase 2 — the checkpointer

Implement `PostgresCheckpointSaver extends BaseCheckpointSaver`.

Five methods: `getTuple`, `list`, `put`, `putWrites`, `deleteThread`.

Test it standalone: run a graph, kill the process, resume, assert it continues.

**Breaks:** nothing. Not wired in yet.

---

### Phase 3 — the new adapter (the big one)

Replace `deep-agents.adapter.ts` with a real `createDeepAgent` binding.

What changes:

- **Delete** the 244-line message state machine and the regex tool parser.
- **Tools:** wrap `ToolRuntime.execute()` in LangChain's `tool()` with Zod schemas.
- **Events:** a `BaseCallbackHandler` writes to our event log. Six hooks — LLM
  start/end/error, tool start/end/error. This is what ap-executor's `AgentTracer`
  already does.
- **Checkpoints:** wire in Phase 2.
- **The port changes.** `advance()` returns one action; `invoke()` runs the whole
  loop. `FrameworkAdapter` becomes `run()`.

The seam is clean: **`advance()` has exactly one call site**,
`run-loop.service.ts:260`, with dispatch at lines 292–314.

**Breaks:**
- `echo-adapter.spec.ts` — rewritten
- `run-loop.service.ts` — the `NextAction` dispatch is replaced
- `NextAction`'s six variants mostly go away; `delegate` and `peer_call` need
  deliberate handling (see Risks)

---

### Phase 4 — skills and memory behind their middleware

Both middlewares take a `backend`, and `BackendProtocol` is a **virtual filesystem**
(`ls`, `read`, `grep`, `write`).

So we project Postgres rows as files:

```
  skills row                 →  /skills/refund-procedure/SKILL.md
  memory_records (semantic)  →  /memory/semantic/<id>.md
```

`createMemoryMiddleware`'s `sources: string[]` maps one path per memory tier.

Our versioning, approval gates, tenant scoping and provenance stay above the
projection. They never move.

**Breaks:** `skills.spec.ts`, `memory.spec.ts`.

---

### Phase 5 — HarnessProfile from our registries

`HarnessProfile` is **not** sandbox isolation. It shapes prompts and tool visibility.

```
  our policy registry  tools.deny     →  excludedTools
  our prompt registry  system prompt  →  baseSystemPrompt / systemPromptSuffix
```

At admission we already resolve both. We compute a `HarnessProfile` from that result.

Bonus: gives us per-model prompt tuning, which we do not have today.

Our `sandbox_profile` column is untouched — different concern.

**Breaks:** `policies.spec.ts`, `prompts.spec.ts` (additive assertions).

---

### Phase 6 — sub-agents replace the pipeline adapter

`createSubAgentMiddleware` / `createSubAgent` replace `pipeline.adapter.ts` (87 LOC).

Consumer 02's six stages become configuration instead of code.

**Breaks:** pipeline tests, `catalog.spec.ts` (constructs adapters directly).

---

### Phase 7 — human-in-the-loop via `interrupt()`

LangGraph's `interrupt()` + `Command` replace our hand-rolled wait/resume.

Our `interactions` table stays — it holds the approval, the reviewer, and the expiry.
`interrupt()` is how the graph pauses and resumes.

**Breaks:** interaction tests.

---

### Phase 8 — MCP

`MultiServerMCPClient` replaces roughly 200 of the 363 lines in
`mcp-registry.service.ts`.

**Keep** our definition-hash pinning. That is a governance feature, not a transport.

**Breaks:** MCP tests.

---

### Phase 9 — the free wins

Once Phase 3 lands, these are configuration, not code:

- **Structured output** — `responseFormat` + Zod. We have nothing today.
- **Filesystem + planning tools** — what consumer 03 needs.
- **Context compaction** — `createSummarizationMiddleware`.
- **`BaseSandbox`** — our container sandbox behind their interface.

**Breaks:** nothing. All additive.

---

### Phase 10 — cleanup

Delete dead code. Update `ai-docs/` claims. Write the ADR recording this reversal.

---

## What we keep, unchanged

Nothing in DeepAgents touches any of this:

- The DB-backed queue. **ap-executor's in-memory semaphore cannot survive a restart
  or span pods. Ours can.** This is the harness earning its place.
- Org / namespace / tenant isolation and RLS
- Admission, capability grants, capability intersection
- Effect contracts — idempotent / non-idempotent / compensatable / approval-gated
- Budgets, cost ledger, backpressure
- Event log and replay through schema changes
- Evals, promotion gates, canary, shadow
- Policy registry, agent registry, versioning
- Lease fencing across a worker fleet
- Residency gating
- A2A peers

## Risks

1. **Cancellation and per-step budget.** With `invoke()` driving the loop, the
   platform cannot check the lease between steps the way it does now. Mitigation:
   `AbortSignal` into `invoke()`, plus the checkpointer so a killed run resumes.
   **Needs proving in Phase 3, not assumed.**

2. **`delegate` and `peer_call` have no DeepAgents equivalent.** Sub-agents there run
   in-process; ours are separate runs with their own lifecycle. Phase 6 must not
   quietly collapse that distinction.

3. **Skills and memory are a projection, not a match.** Rows rendered as files. If
   the middleware assumes real file semantics somewhere, we will find out in Phase 4.

4. **Test churn.** 10 of 38 test files are in the blast radius. The suite must stay
   green at each phase boundary, not only at the end.

5. **`run-loop.service.ts` is 1713 lines** and Phase 3 changes its centre. This is the
   phase most likely to need splitting.

## Order and why

```
  0  packages + spike        independent, cheap
  1  providers               independent, immediately valuable, unblocks real LLM tests
  2  checkpointer            independent, provable standalone
  ───────── 1 and 2 must land before 3 ─────────
  3  the adapter             the big one; everything below depends on it
  4  skills + memory
  5  harness profile
  6  sub-agents
  7  HITL
  8  MCP
  9  free wins               additive
 10  cleanup
```

Phases 0–2 are safe and can start now. Phase 3 is the one to review carefully before
writing it.

## Open questions

1. Does `run-loop.service.ts` get split as part of Phase 3, or after?
2. Do we keep `FrameworkAdapter` as a port at all? If DeepAgents is the only
   implementation, the abstraction may no longer earn its keep — but dropping it
   contradicts §2.1's "core compiles with adapters removed".
3. Phase 1 needs the real `TEST_LLM_KEY` back in `.env`.
