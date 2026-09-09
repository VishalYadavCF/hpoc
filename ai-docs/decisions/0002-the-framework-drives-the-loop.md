# ADR 0002 — The framework drives the loop

**Status:** accepted (2026-09-09) · **Supersedes:** the `advance()` design in
`ai-docs/plans/lld.md` §4 · **Implements:** `ai-docs/plans/deepagents-migration.md`

## The reversal

`FrameworkAdapter` used to be:

```ts
advance(input: AdvanceInput): Promise<AdvanceOutput>   // ONE step
```

It is now:

```ts
run(session: RunSession): Promise<RunOutcome>          // the whole run
```

The original reasoning, quoted from the LLD:

> `advance()` returning **one step** rather than running a loop is the central design choice
> of the adapter boundary: it is what lets the platform own checkpointing, cancellation,
> budget enforcement and the event log, while the framework owns reasoning.

That is right about the goal and wrong about the mechanism.

## What it actually cost

Because the platform decided every step, the framework could not. So the `deep-agents`
adapter — 244 lines — was a hand-written message state machine that **never called
`createDeepAgent`**. Its own docblock admitted this. In its place we had:

| DeepAgents has | We had |
|---|---|
| native tool calling | a regex matching `TOOL name {json}` out of prose |
| planning / todo tools | nothing |
| a scratch filesystem | nothing |
| skills middleware, progressive disclosure | every skill's full body in every prompt |
| memory middleware | the same, concatenated |
| named in-process sub-agents | nothing; every hand-off was a separate run |
| summarization | nothing; the transcript was unbounded |
| structured output | nothing; ask for JSON in prose and parse it |
| a checkpointer | ours, but the framework's state was not in it |

And the reason ap-executor has no checkpointing is not that DeepAgents cannot: it is that
ap-executor has no database. We have one. **Swapping the storage was the entire trick.**

## The insight that made the reversal safe

The guarantees never depended on owning the loop. They depended on being **the only path to
anything with a consequence**.

So they moved down, into `RunHost`. A framework reaches a model or a tool only by calling
back into the platform:

```
  framework asks for a model call
        │
        ▼
  RunHost.callModel
     - budget + step-ceiling check      ← was the top of the for-loop
     - transaction + lease fence        ← was around the dispatch
     - residency gate, cost ledger,
       cache, fallback (§9)
     - steps row + ModelCompleted event
        │
        ▼
  framework keeps reasoning
```

| Guarantee | Before | Now |
|---|---|---|
| residency, cost, cache, fallback | `runModelStep` | `HostChatModel` → `callModel` (same code) |
| effect contracts, idempotency | `runToolStep` | tool wrapper → `callTool` (same code) |
| per-step budget, lease fencing | top of the drive loop | `RunHost.step`, around both |
| maxSteps | loop condition | host counter **and** `recursionLimit` |
| cancellation | between steps | `AbortSignal` + the host's own stop check |
| durability | our checkpoints | ours, plus `PostgresCheckpointSaver` for graph state |
| suspension (§13.3, §14) | `NextAction` variants | LangGraph `interrupt()` + `Command` |

The platform gave up deciding **when** the next model call happens. It never had an opinion
about that.

## What we did NOT collapse

Two things the plan proposed to merge, and that working through them said to keep apart —
though the first only after a correction.

**Sub-agents: three shapes, and the author picks.** The first draft of this ADR claimed a
registered sub-agent could not run in-process because it would "silently use the caller's
model and tool grants". That was **wrong on the facts** — DeepAgents' `SubAgent` takes both
`model` and `tools` per sub-agent. The objection did not survive checking, so the feature
was built.

| | `task` → inline helper | `task` → `mode: 'inline'` | `delegate_to_<alias>` |
|---|---|---|---|
| Declared as | `inlineSubAgents` | `subAgents: [{name, mode:'inline'}]` | `subAgents: ['name']` (default) |
| Registered agent | no | **yes** | yes |
| Prompt / tools / model | caller's, narrowed | **the child's own** | the child's own |
| Own policy | n/a — no version | applied at ITS admission | applied at its admission |
| Runs in | caller's run | caller's run | **its own run** |
| Step ceiling, lease, signal | caller's | caller's | its own |
| Cost ceiling | caller's | tighter of the two | its own |
| Attribution | caller's version | `steps.agent_version_id` | its own run |
| Retries, dead-letter, inspectable run | no | **no** | yes |
| Cost of a hand-off | none | none | a queue round trip |

`mode: 'inline'` is the opt-in. Everything the child uses is its own — pinned prompt, own
bindings, own model and residency class, own skills under `/agents/<alias>/skills/` — because
`RunHost.forSubAgent(alias)` hands the adapter a host scoped to the child's version. What it
shares is the run: the same lease, step ceiling and cancellation signal, and the **tighter**
of the two cost ceilings, so a generous stage cannot overspend a frugal caller.

What it gives up is everything that lives on a run row: **no retries, no dead-lettering, and
no run for an operator to inspect or resume.** A failure returns into the caller's reasoning
(§13.5 containment) instead of becoming something someone can go and look at. That is the
trade the author makes by writing `mode: 'inline'`, and it is why `run` stays the default —
including for a binding the spec forgot to name, and for one whose agent will not resolve.

Two smaller rules fall out. An inline binding is reached through `task` and gets **no**
`delegate_to_` handle: offering both would let the model choose a semantics it cannot reason
about. And an inline child cannot itself spawn inline children — unbounded nesting inside one
run, with no delegation chain for §4.6 to check against.

**`pipeline.adapter.ts` stays.** It was slated for deletion. It is the only *deterministic*
orchestrator, and a six-stage pipeline is precisely the case where the model must not
choose the order. It is also the port's proof that a framework with no checkpointer of its
own can still be resumed correctly — which is what `RunHost.saveState` exists for.

## The sharpest edge, and how it is handled

`run()` is re-entered **from the top** after a suspension. An adapter that simply
re-executes calls every tool it already called — including the non-idempotent one a human
just approved. A duplicated side effect, caused by the platform politely asking again.

LangGraph makes this worse before it makes it better: it resumes by re-executing the whole
interrupted super-step, so *siblings* of the suspended call replay too.

`ReplayLedger` records every settled call under the tool-call id the **model** minted —
which lives in checkpointed graph state and is therefore identical on replay — and is
written *before* `interrupt()`, because `interrupt()` throws a control signal that unwinds
the graph. The platform's own `tool_invocations.idempotency_key` does not cover this: it
renders from `{runId, stepId}` and a replay gets a fresh step, so the key differs and the
dedupe never fires. That mechanism is about retrying one step; this is about not re-entering
a step that already finished.

## Defects this surfaced

Each was live before the migration, or introduced and caught during it. Listed because
they are the evidence that the exercise was worth doing.

1. **Every vendor SDK retried by default**, underneath the gateway's own fallback. One
   upstream 500 became several billed calls. Fixed with `maxRetries: 0`.
2. **`models.base_url` semantics changed** when the SDKs took over: the seeded Gemini row
   ended in `/v1beta`, which the SDK would have turned into `/v1beta/v1beta/…` — a 404 that
   reads like a bad credential. Migration `0025`.
3. **`maxSteps` was off by one.** The old loop checked the ceiling before asking for the
   next action, so discovering "done" cost a step: `maxSteps: 50` meant 49 usable ones, and
   a run that used exactly its allowance failed *after* producing an answer.
4. **The MCP client never sent `initialize`.** The protocol requires it. Our fake server
   never had to answer it, so the omission was invisible — and any spec-compliant server
   would have rejected us.
5. **The model cache key ignored the transcript.** Two calls with the same trailing prompt
   but different tool results before it shared an answer.
6. **`makeHost` returned `Object.assign(api, host)`**, which copies primitives by value, so
   callers read a snapshot of `stepSeq`/`stopped`/`suspended` taken before the run began —
   and the platform's stop check would have read `null` forever, turning an exceeded budget
   into a completed run.
7. **The pipeline adapter inferred stage failure** by sniffing the payload for an `error`
   key, so a stage whose legitimate output mentioned an error would have halted the
   pipeline. `RunSession.resume.failed` now states it.

Number 6 was found only after noticing that the API and worker on `:3000` were still
running binaries built before the migration — so every HTTP-driven test had been passing
against the old run loop. **That is the process lesson: a green suite against a stale
binary is not a green suite.**

## What is deliberately not done

- **`BaseSandbox`.** The filesystem tools run against an in-memory projection with no host
  access, so they are sandboxed by construction. Wiring `BaseSandbox` would *grant* shell
  execution that does not exist today — a capability increase behind a policy decision, not
  a free win.
- **`registerHarnessProfile`.** DeepAgents' profile registry is process-global and keyed by
  model spec, so two tenants with different policies on the same model would silently
  overwrite each other in whichever order their runs started. The profile's fields are
  applied per-run instead.
- **Scratch-file durability.** Writes to `/workspace` live for one drive and do not survive
  a suspension. Persisting them means graph state or the artifact store, which is a separate
  decision.

## Cost

Roughly 750 lines deleted (a message state machine, a regex tool parser, three vendor HTTP
clients, two MCP transports) against a smaller amount added, most of it a
`BaseChatModel`, a checkpointer and a virtual filesystem — all of them adapters to
interfaces someone else maintains.

The suite went from 341 to 380 passing.
