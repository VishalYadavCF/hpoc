# 01 — Why the last one was inaccurate

Read from `~/PycharmProjects/relay-agent-builder`, mainly its own post-mortems
in `docs/classA_deterministic_dsl_assembly.md` and
`docs/classB_learning_and_context.md`.

## The root cause, in one sentence

**The model was asked to write down facts that were already known, and nobody
kept score.**

Everything below is a symptom of that one sentence.

---

## Symptom 1 — the model hand-wrote a fixed contract

Stage N6 (`dsl_drafting_agent`) was asked to produce the whole DSL. That
included large parts that never vary. Each of those parts was a fresh chance to
guess wrong. It guessed wrong often.

Real examples that were found:

| Field | What the model wrote | What is correct |
|---|---|---|
| `executionInfo.actionName` | `makeCall` | `make_call` — the raw name, never camelCase |
| Trigger `eventData.eventType` | *missing* | `ABANDONED_CHECKOUT` — the backend rejects the build without it |
| Variable reference | `${trigger.output.input_data.data.phone}` | `${node_1.output.data.phone}` |
| `data.name` | `piece-osvi-ai` | `Osvi AI` |
| Trigger node source | built from the sample payload | must be built from the trigger definition |

Look at the reference row. It is wrong in two separate ways at once. It used the
word `trigger` where a node id belongs, and it kept an `input_data.` prefix that
should not be there. Neither is a judgement call. Both are derivable from data
the pipeline had already fetched two stages earlier.

**The lesson:** none of this was creative work. It was transcription. Models are
bad at transcription and code is perfect at it.

---

## Symptom 2 — the local validator encoded a guess

The project had 28+ local validation rules. One of them, `V22`, rejected dashes
in `executionInfo.actionName`.

The real Relay UI emits `create-payment-link`. With a dash.

So the validator was **rejecting correct output**. Then the repair loop would
dutifully "fix" the correct DSL into incorrect DSL, and the model would learn
from the repair that it had made a mistake when it had not.

**The lesson:** a validator that guesses the contract is worse than no
validator. It converts one error into a loop that manufactures more.

---

## Symptom 3 — the wrong field was read off the wire

Node testing returns this envelope:

```
{ executionId, taskId, executionCallStatus, pluginResponse, error }
```

The actual node output is `pluginResponse`. The code read the whole envelope.

So every output shape the system learned and stored was the shape of the
envelope. Later stages then built references pointing at `executionId` and
`taskId` — fields that have nothing to do with the merchant's data.

**The lesson:** one wrong line in an adapter poisoned the entire memory. The
memory was working correctly. It was faithfully remembering garbage.

---

## Symptom 4 — grounding happened before anything ran

The pipeline resolved every schema up front, in stage N5, before executing
anything.

But some things cannot be known in advance. If a router branch has to decide
"did the voice call report that the coupon was accepted?", the field that
carries that answer is not in any catalog. It only exists once you actually run
the node and look at what came back.

Having no answer, the pipeline asked the user: *which output field means
accepted?*

A merchant cannot answer that. They have never seen the payload.

**The lesson:** the order was wrong. Configure a node, run it, look at the real
output, and only then let the next node reference it.

---

## Symptom 5 — async actions were concluded from the acknowledgement

Some actions return instantly with nothing useful. A voice call returns
`{callId}` and hangs up. The real result — did anyone pick up, what did they
say, did they accept — arrives minutes later by webhook.

The builder read the immediate response and stored that as the output shape. One
field. Wrong.

**The lesson:** "the call returned" and "the call finished" are different
events. You have to poll until the result settles, with a timeout, and you must
never silently treat a timeout as an answer.

---

## Symptom 6 — the cache changed history

There was an `llm_cache` table inside the agent, keyed on a prompt hash.

A cache hit and a cache miss produced *different stored transcripts* for the
same build. So you could not trust the recorded history of a run, which means
you could not debug an inaccurate build after the fact.

**The lesson:** a cache that sits inside the agent corrupts the audit trail.

---

## Symptom 7 — nobody was keeping score

This is the one that matters most.

The project's own note reads:

> "114 total pass. Live end-to-end (real test-action shape) still unverified."

114 unit tests, and no answer to the only question anyone actually cared about:
**out of 20 real merchant requests, how many produce a workflow that runs?**

Without that number:

- You cannot tell an improvement from a regression.
- You cannot tell a real improvement from a lucky run.
- Every fix is argued from one anecdote.
- "It's more accurate now" is an opinion.

**The lesson:** accuracy is not a feeling. It is a number with an error bar, or
it is nothing.

---

## The two rules we carry forward

**Rule 1 — If the answer is always the same, code writes it.**
The model only supplies what genuinely varies from request to request. Every
mechanical field the model touches is a defect waiting to happen.

**Rule 2 — If we cannot score it, we cannot claim it improved.**
Before we build the builder, we build the scoreboard.

Everything in `02`, `03` and `04` follows from these two rules.
