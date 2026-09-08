# 03 — What the platform already gives us

The eleven parts from `02` mapped onto the platform. The short version: most of
it exists. What we have to build is the Relay-specific half.

## The map

| # | What the builder needs | Platform gives us | Status |
|---|---|---|---|
| 1 | A conversation that survives | Threads, durable runs, SSE with resume | Built |
| 2 | A fresh catalog | Tools registry + knowledge collections | Built, needs Relay content |
| 3 | The six planning stages | Sub-agents + the `pipeline` framework adapter | Built |
| 4 | The deterministic assembler | Sandbox code execution (a function tool) | Runtime built, assembler is ours |
| 5 | A validator mirroring the backend | Same — a function tool | Runtime built, rules are ours |
| 6 | The probe loop | HTTP tools with effect contracts | Built |
| 7 | Memory, three kinds | Memory tiers + cross-tenant sharing policy | Built |
| 8 | Every draft kept | Artifacts | Built |
| 9 | Two human gates | Interactions, with expiry | Built |
| 10 | A scoreboard | Eval suites, `json_path` grader, variance handling | Built |
| 11 | Write-back to Relay | Tools with idempotency keys | Built |

Nothing in the left column is blocked on platform work.

---

## The pieces worth calling out

### The pipeline adapter already exists, and it was written for this

`src/adapters/framework/pipeline/pipeline.adapter.ts` runs a list of sub-agents
in order, feeding each one the previous one's output, and stops the whole thing
if a stage fails. Its own comment says it is consumer 02's shape.

So the six stages do not need any new orchestration code. They are six
sub-agents under one registered agent, in one namespace.

```
  agent: workflow-builder
    ├── intent
    ├── trigger
    ├── topology
    ├── schema-grounding
    ├── dsl-drafting
    └── correction
```

They are sub-agents, not peers, because one team owns all six and they deploy
together. A network hop between two of them would be a mistake.

### The assembler can run in the sandbox

We recently made function tools actually execute code — Node or Python, in a
container, no network, read-only filesystem.

That matters here. The deterministic assembler is pure logic: plan in, DSL out.
It can be registered as a function tool and run in the sandbox.

Two things we get from that:
- The assembler is **data**, not a deploy. Fixing an assembler bug is an update
  to a registered tool, not a release of the builder service.
- Every assembly run is recorded like any other tool call, with its input and
  output, so we can replay it.

The same applies to the validator.

This is a decision, not a given — see `05-open-questions.md`.

### The cross-tenant memory question is already answered

The old design wanted a shared, PII-stripped corpus so one merchant's
successful build teaches the next. That conflicts with tenant isolation.

The platform resolved it: `memory_sharing_policies`. A namespace opts in, per
memory tier, naming the redaction policy it applies, approved by a named
principal, and revocable without deleting what others built on.

So we can share "the output shape of `osvi.make_call`" across merchants, and
keep "what this merchant's customers said" strictly per-merchant. And we can
prove which is which.

The consumer profile listed this as blocking. It no longer is.

### Approvals are already a real thing

Both gates — activation and lesson approval — become Interactions. The run goes
to `waiting`, a reviewer answers, the run resumes.

The important part is expiry. In the old project a lesson could sit in
`REQUESTED` forever and nothing happened. Here an expired interaction is a
defined outcome of the run, not a hang.

### Replay is what makes an inaccurate build debuggable

When a merchant says "it built the wrong thing", we can replay the run from its
event log and see exactly what each stage decided.

This only works because the cache is not inside the agent. Replay reads recorded
outputs, never the cache. That is symptom 6 from `01` fixed by construction.

---

## What is genuinely ours to build

Everything Relay-specific:

1. **The golden corpus.** Real workflows exported from the Relay UI. This is the
   source of truth for the assembler, the validator and the scoreboard. Without
   it none of the three can be correct.
2. **The assembler.** Plan → DSL, every mechanical field.
3. **The validator rules**, generated from the golden corpus rather than
   written by hand.
4. **The Relay tools**: list pieces, list actions, get trigger event, create
   workflow, test action, get execution details, update workflow, activate.
5. **The six prompts.** These carry over from the old project mostly unchanged,
   but each becomes a versioned prompt in the registry so a prompt change is a
   reviewable diff.
6. **The eval suite.** The scoreboard itself.

## Effect contracts for the Relay tools

Worth writing down early, because they change how the platform treats each call.

```
  relay.catalog.pieces.list      read only, cacheable 5 min
  relay.catalog.actions.list     read only, cacheable 5 min
  relay.trigger.get              read only, cacheable 5 min

  relay.workflow.create          essential, idempotent
  relay.workflow.update          essential, idempotent
  relay.action.test              essential, NOT idempotent   ← it really calls people
  relay.workflow.activate        essential, idempotent, needs human approval
```

`relay.action.test` is the interesting one. Testing a voice-call node places a
real phone call. It is not safe to retry blindly, and if we crash mid-call we
genuinely do not know whether it happened. The platform's position is to say so
rather than pretend, which is the correct answer here.

It is also the reason sandbox-vs-production is a real decision and not a detail.
