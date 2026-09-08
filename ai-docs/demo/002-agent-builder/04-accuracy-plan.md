# 04 — The accuracy plan

Rule 2 from `01`: if we cannot score it, we cannot claim it improved.

So the scoreboard gets built **first**, before the builder. Otherwise we repeat
the last project exactly.

---

## "Accurate" is three different questions

Lumping them together is how the last project lost track. They fail
independently and they need separate numbers.

```
  Q1  Is it well-formed?      → does our validator accept it?
  Q2  Does it actually run?   → does Relay accept it and execute it?
  Q3  Is it what they asked?  → does it do what the merchant said?
```

A build can pass Q1 and fail Q2. That is the `V22` case — our rules said yes,
the real backend said no.

A build can pass Q1 and Q2 and fail Q3. It runs beautifully and sends the coupon
to the wrong person.

Three questions, three scores, never averaged into one.

---

## The golden corpus

Everything starts here. We need real workflows, exported from the Relay UI,
that we know are correct because a human built them and they work.

For each one we record:
- the sentence a merchant would have typed to ask for it
- the exported DSL, unchanged

Target: **20 to 30** covering the shapes we care about.

```
   simple  ─  trigger → one action
   chain   ─  trigger → action → action
   branch  ─  trigger → router → two branches → merge
   wait    ─  trigger → wait → action
   async   ─  trigger → voice call → branch on the result
```

This corpus does three jobs at once:

1. It is the **specification** for the assembler. Every mechanical field is read
   off these files, not out of anyone's head.
2. It is the **source** of the validator rules. If a rule rejects a golden
   export, the rule is wrong. Not the export.
3. It is the **scoreboard**.

If we only do one thing before writing any code, it is this.

---

## How a case is scored

Each golden workflow becomes one eval case. Input is the merchant sentence.
Expectation is a set of assertions against the DSL we produce.

The assertions are split into two bands, and **they are scored separately**.

```
  ┌─ BAND A — contract ─────────────────────── weight 1.0 ──┐
  │  executionInfo.actionName        exact                   │
  │  executionInfo.plugin.*          exact                   │
  │  executionInfo.config keys       exact                   │
  │  trigger eventData.eventType     exact, non-blank        │
  │  variable references             exact                   │
  │  edges and sourceHandle          exact                   │
  │  router branches / default       exact                   │
  │                                                          │
  │  If any of these is wrong, the workflow does not run.    │
  └──────────────────────────────────────────────────────────┘

  ┌─ BAND B — appearance ───────────────────── weight 0.1 ──┐
  │  data.name / displayName                                 │
  │  data.icon                                               │
  │  _meta.*                                                 │
  │  descriptions                                            │
  │                                                          │
  │  If these are wrong, it runs but looks broken.           │
  └──────────────────────────────────────────────────────────┘
```

Why separate: a build that renders prettily but will not execute must not score
well. If we average the bands, twelve correct cosmetic fields hide one fatal
`actionName`.

The platform's `json_path` grader does exactly this shape of assertion.

---

## Run each case more than once

Model output varies. The same input twice can give different DSL.

So every case runs several times — start at 5. The suite reports a mean **and a
spread**. Two consequences:

- A case only counts as passed if it passed **every** trial. One flaky case is
  a broken case.
- When we compare two versions, a difference smaller than the noise is reported
  as **inconclusive**, not as an improvement.

That last point is the guard against the thing that wasted the most time last
round: shipping a change because one run looked better.

```
   version A   0.74
   version B   0.80        looks like +0.06

   spread      ±0.08       →  INCONCLUSIVE. Run it again.
   spread      ±0.01       →  real improvement.
```

The platform does this already — `trials_per_case`, `score_stderr`, and an
`inconclusive` verdict.

---

## Prove the assembler was worth building

The whole design rests on one claim: **moving mechanical fields from the model
to code makes builds more accurate.**

That claim has to be measured, not assumed.

The platform supports running the same suite twice, with a mechanism on and off:

```
   arm OFF   model writes the whole DSL       (the old design)
   arm ON    model plans, code assembles      (the new design)
              ─────────────────────────────
              delta, with an error bar
```

If the delta is small, the assembler is not earning its complexity and we should
know that. My expectation is it will be large, because the errors in `01` are
almost all mechanical. But an expectation is not a measurement.

Same technique for the other choices:
- Does recalling past lessons help, or is it noise?
- Does probing real outputs beat grounding from the catalog?

Each is a mechanism. Each gets an A/B. Anything that cannot show benefit gets
deleted rather than kept out of politeness.

---

## Wire the score to promotion

Once the suite exists, a new version of the builder cannot go to production
unless it clears the bar. The platform has promotion gates for this, plus canary
and shadow traffic.

Shadow is especially useful here: run the new builder against real merchant
requests alongside the old one, compare, and ship nothing to the merchant until
we like the comparison.

---

## Order of work

```
  1. Collect the golden corpus            ← nothing else works without it
  2. Turn it into an eval suite
  3. Measure the OLD builder against it   ← this is our baseline number
  4. Build the assembler
  5. Measure again, A/B against the baseline
  6. Only then: the probe loop, memory, lessons
```

Step 3 is the one that will be tempting to skip. It is the most valuable step in
the list. Until we have a baseline number, every later claim is unfalsifiable.

---

## What we should be able to say at the end

Not: "it's much better now."

But: **"On 24 real merchant requests, 21 produce a workflow that Relay accepts
and runs, up from 12. Measured over 5 trials each. The spread is ±0.04, so the
improvement is real."**

That is the sentence the demo needs.
