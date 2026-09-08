# 02 — What the builder needs

Plain list of the parts. No code, no file names yet.

## The shape of one build

```
  merchant types a sentence
            │
            ▼
  ┌───────────────────────────────────────────────┐
  │  UNDERSTAND   (the model decides)             │
  │  what do they want · which trigger ·          │
  │  which pieces · in what order                 │
  └───────────────────┬───────────────────────────┘
                      │  a plan, not a DSL
                      ▼
  ┌───────────────────────────────────────────────┐
  │  PROBE        (run things, look at answers)   │
  │  test each node · store its real output shape │
  └───────────────────┬───────────────────────────┘
                      │  real field names
                      ▼
  ┌───────────────────────────────────────────────┐
  │  ASSEMBLE     (code, not the model)           │
  │  build every mechanical field exactly         │
  └───────────────────┬───────────────────────────┘
                      │  a complete DSL
                      ▼
  ┌───────────────────────────────────────────────┐
  │  CHECK        (validate · test · score)       │
  └───────────────────┬───────────────────────────┘
                      │
                      ▼
  ┌───────────────────────────────────────────────┐
  │  ASK A HUMAN  before going live               │
  └───────────────────┬───────────────────────────┘
                      ▼
              write back to Relay
```

The important change from the old design is the **third box**. Previously the
model produced the DSL and code checked it. Now code produces the DSL and the
model only produces the plan.

---

## The split: what the model decides, what code builds

This table is the heart of the whole design. Getting it right is most of the
accuracy work.

```
   THE MODEL DECIDES                 CODE BUILDS
   (genuinely varies)                (always the same)
   ─────────────────────             ────────────────────────────
   what the merchant meant           the trigger node
   which trigger event               eventData and eventType
   which pieces and actions          _meta blocks
   what order they go in             executionInfo
   whether a branch is needed        plugin id / name / version
   what the branch tests             config (= parameters minus _meta)
   what values go in the fields      variable reference syntax
   the wording of any message        router / merge / end nodes
                                     edges and sourceHandle
                                     which fields are required
```

Rule of thumb from the old project, and it is a good one:

> If the exported workflow from the UI always looks the same in that spot,
> code builds it. If the right answer depends on the merchant, the model
> decides it.

---

## The parts we need

### 1. A conversation that survives
The merchant will not get it right in one message. They will say "actually make
it 15%", or come back tomorrow. We need a thread that holds many turns and many
builds, and a live stream so the UI can show progress.

### 2. A fresh catalog
The list of pieces, their actions, their fields, and the trigger events. This
must be versioned. When a piece version changes, everything we learned about it
is stale and must be re-learned, not reused.

### 3. The planning stages
Roughly the six the old project had — understand intent, pick the trigger, plan
the topology, ground the schemas, draft the values, correct mistakes. These stay
as they are. They were not the problem.

### 4. A deterministic assembler
Code that takes the plan and produces the DSL. This is the new part and the most
important one. It owns every field in the right-hand column above.

It must be built from a **golden export** — a real workflow saved from the Relay
UI — not from a description of the format.

### 5. A validator that mirrors the real backend
Not our guess at the rules. The `V22` incident happened because someone wrote
down a rule that was never true.

Best case: Relay exposes a validate endpoint and we call it. Second best: we
generate our rules from golden exports and treat any disagreement with a golden
export as a bug in our rules, never in the export.

### 6. A probe loop
Configure a node, run it for real, watch what comes back, remember the shape.
Only then let the next node reference it.

This has to handle slow actions. A voice call answers immediately with an id and
tells you nothing. We poll until the result settles or a timeout fires. On
timeout we mark that branch as unfinished and say so — we never guess.

### 7. Memory, in three kinds
- **What shapes look like** — the output shape of each action, shared across
  merchants, stripped of any real customer data.
- **What we got wrong before** — when a human edits our workflow in the UI, that
  edit is a correction. Capture the difference and turn it into a lesson.
- **What this merchant prefers** — sandbox or production, which connection,
  which tone.

Lessons need a human to approve them before they influence future builds. An
unreviewed lesson is a rumour.

### 8. Every draft kept
Each DSL we produce is stored, unchanged, forever. When a build comes out wrong
we need to look at exactly what we produced, not a reconstruction.

Relay stays the owner of the real workflow. We only ever hold proposals.

### 9. Two human gates
- Before a workflow goes **live**. This is real money and real customers.
- Before a **lesson** enters shared memory.

Both must expire. A gate that waits forever is a hang, not a gate.

### 10. A scoreboard
A fixed set of real merchant requests with known-correct answers. Run it on
every change. This is covered in `04-accuracy-plan.md`.

### 11. Write-back to Relay
Create the draft, update it, and activate it. Each of these needs an idempotency
key so a retry does not create a second workflow.

---

## What we are deliberately not building

- Our own workflow storage. Relay owns workflows. We hold drafts.
- Our own cache inside the agent. That was symptom 6.
- Our own approval status columns. Approvals are a first-class thing already.
- Our own event table. There is one.
