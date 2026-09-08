# 05 — Open questions

Things to decide before building. Roughly in the order they block work.

---

## Q1. Can we get the golden corpus, and from where?

**Blocks everything.** The assembler, the validator and the scoreboard are all
derived from it.

Options:
- Export 20–30 workflows from a Relay environment we have access to.
- Ask the Relay team for a set they consider representative.
- Build them by hand in the UI ourselves.

Second question attached to this: **is there a Relay environment we can point at
for real node testing**, or do we work against mocks for the demo?

My view: hand-building 10 in the UI ourselves is slow but unblocks us today, and
we would understand the format properly by the end of it.

---

## Q2. Does Relay have a validate endpoint?

If yes, we call it and we never write a validation rule again. The `V22`
incident becomes impossible.

If no, we generate rules from the golden corpus, and we adopt one hard
discipline: **a rule that rejects a golden export is a broken rule.** Never the
other way around.

Worth asking the Relay team directly before we build anything.

---

## Q3. Where does the assembler live?

Three options.

```
  (a) A function tool, run in the sandbox
      + fixing a bug is a registry update, not a deploy
      + every run recorded and replayable
      - a container start per assembly, so slower
      - the assembler is now a versioned artifact to manage

  (b) Inside the builder service
      + simplest, fastest
      - a fix means a service deploy
      - not visible to replay

  (c) Inside the platform
      - no. Relay's DSL is not the platform's business.
```

(c) is out. Between (a) and (b), I lean (a) — the whole point of this exercise
is that the assembler will be wrong at first and will need frequent correction.
Making that a data change rather than a deploy matters more than the latency.

But it makes the sandbox load-bearing for the demo, and the sandbox image is not
purpose-built yet.

---

## Q4. Sandbox or production for node testing?

Testing a node runs it for real. A voice-call node calls a real phone.

The old project silently chose production for a payment link. That is the kind
of default that ends up in an incident review.

Proposal:
- Default to sandbox, always.
- Production requires the merchant to say so explicitly.
- Remember the choice per merchant after asking once.

Needs confirming: does Relay expose sandbox credentials for every piece, or only
some? If only some, what do we do for the rest — refuse to test, or test in
production with an explicit gate?

---

## Q5. How do we handle an async action that never settles?

A voice call may not be answered. The build cannot wait forever.

The old project's decision was: poll with a timeout, and on timeout mark the
branch as needing manual field selection, then build anyway and say so.

That seems right. Confirming it, and deciding the timeout. My instinct is 60–90
seconds for the demo, and it must appear in the trace, never silently.

Related: where a piece publishes a sample output shape, prefer that over a live
call. We want the shape, not one call's outcome.

---

## Q6. Six sub-agents in one run, or six runs on one thread?

Mostly settled — the `pipeline` adapter exists and does sub-agents in one run,
and it was written for this consumer.

The trade-off is worth stating anyway:
- **One run, six sub-agents:** they share context, a failed stage fails the
  whole build, one checkpoint.
- **Six runs on a thread:** each stage retries independently, but every stage
  has to rebuild its context.

I would keep one run. Worth a sentence of confirmation, not a debate.

---

## Q7. What exactly are we demoing?

This changes how much we build. Three sizes:

```
  Small   sentence → correct DSL, shown side by side with the golden export
          plus the eval score. No Relay write-back.

  Medium  small, plus create the draft in Relay and test one node.

  Large   the whole thing, ending in a live activated workflow.
```

Small is honest, quick, and shows the accuracy story clearly — which is the
interesting part. Large is more impressive and depends on Relay access we may
not have.

My recommendation is **Small, with one Medium example** if we get an
environment.

---

## Q8. How fresh does the catalog need to be?

Pieces and their actions change. Everything we learned about a piece is keyed to
its version.

Decide: do we cache the catalog per session, per hour, or fetch every time? The
old project noted it was wasting ~50k tokens re-fetching action lists.

The platform can cache read-only tool results with a TTL, so this is a
configuration choice rather than code. Just needs a number.

---

## Q9. Who approves lessons?

Both gates need a named reviewer and an expiry.

- Who approves a lesson before it enters shared memory?
- Who approves a workflow going live — us, or the merchant?
- How long before an unanswered approval expires, and what happens then?

For the demo we can be the reviewer for both. For real use this needs an answer.

---

## Not blocking, but worth noting

- The sandbox image is a public `node:22-alpine` / `python:3.12-alpine`, not
  purpose-built, and egress is one global setting rather than per-profile. Fine
  for a demo, not for production.
- If we do the Large demo, `relay.action.test` is non-idempotent and a crash
  mid-call leaves a genuinely unknown outcome. The platform will say so rather
  than guess, which is correct but will look like a failure in a demo unless we
  explain it.
