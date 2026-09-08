# Eval harness

> §0.5: *"Each mechanism has an eval demonstrating current benefit; one that cannot be
> shown to help is removed."*
>
> §15.5: *"§15.5 makes this operational by wiring evals into the deployment gate. Without
> that, this constraint is aspirational."*

Everything shipped in the last several batches — memory, context compaction, skills,
knowledge, the model cache, sub-agents, peers — is a **compensating mechanism**: code that
exists because today's models have a weakness, and that becomes dead weight or actively
harmful when they improve on that axis. §0.5 says each must be individually disableable
and must justify itself. Until now none of them could be measured.

## What the harness answers

Two questions, and the second is why it exists.

**"Is this version good enough to ship?"** — score a version against a suite, gate
promotion on it. Ordinary.

**"Does this mechanism actually help?"** — run the *same suite* against the *same version*
twice, with the mechanism on and off, and compare. That is what converts §0.5 from a
principle into an enforced gate.

## The A/B, and why the off-arm is a real version

`mechanism_under_test` on a suite names one mechanism. The runner then:

1. Executes arm A: the version exactly as published.
2. Calls `withMechanismDisabled(spec, mechanism)` — one spec field flipped.
3. Puts that variant **through admission** and materialises it as its own agent version.
4. Executes arm B on that version, over comparable cases only.
5. Compares.

Step 3 is the load-bearing one. The tempting shortcut is a runtime flag that suppresses
memory recall for the duration of an eval — but that measures a configuration nobody can
deploy, so a "mechanism justified" verdict would be evidence about a thing that does not
exist. The off arm is a real, admissible, separately-admitted version executed through the
ordinary run engine.

`withMechanismDisabled` returns **null** when the mechanism is already off. That is not an
edge case to smooth over: comparing a spec against an identical spec yields a delta of
exactly zero, which would be reported as "no benefit" — a conclusion about the mechanism
drawn from a comparison that never happened.

## Eval runs are real runs

Cases execute through `RunService.createFromVersion` — the same queue, the same worker, the
same event log, the same effect contracts. A parallel execution path inside the harness
would let it measure something production does not do, and the discrepancy would surface
the first time a suite passed and the deploy failed.

Consequences worth knowing:

- Cases cost real money and take real time. `caseTimeoutMs` bounds each one, and a timed-out
  case is **cancelled**, not abandoned — otherwise it keeps spending the tenant's budget
  after the suite that asked for it has already reported.
- No idempotency key is set. Two arms send identical inputs, and a key derived from the
  input would make arm B replay arm A's run and report a delta of exactly zero.

## The verdict refuses to overclaim

A 0.1 difference over four cases is noise. Reporting it as "the mechanism helps" is worse
than reporting nothing, because it launders a coin flip into evidence that will be cited
later.

So there are two explicit thresholds and one floor:

| | Meaning |
|---|---|
| `min_score` | The bar a version must clear. On the **suite**, not per run — a threshold supplied at call time can be lowered until it passes. |
| `min_mechanism_delta` | How much better the mechanism must make things. Default 0.05. Zero would mean any positive noise counts. |
| `MIN_COMPARABLE_CASES = 5` | Below this, the verdict is `inconclusive` — not justified, and **not** not-justified either. |

**This harness does no significance testing.** Five is a chosen floor that stops a two-case
suite from deciding a mechanism's fate; it is not a substitute for a real experiment, and
the `inconclusive` rationale says so in words. Pretending otherwise would be exactly the
overclaim the verdict logic exists to prevent.

Note the asymmetry in the remaining two verdicts: a delta inside the margin returns
`mechanism_not_justified`, not `inconclusive`. §0.5 puts the burden of proof on **keeping**
a mechanism, not on removing it — a mechanism that cannot demonstrate benefit is dead
weight by default.

## Graders

Six deterministic, one judged. Every grader must return a score for a **failed** run
rather than throwing: a crash is a result, and treating it as "no data" is how a broken
version passes a suite by not answering.

| Grader | Scores | Note |
|---|---|---|
| `exact` | Normalised equality | Whitespace/case-normalised — an assertion that fails on trailing whitespace tests the harness, not the agent |
| `contains` | **Fraction** of required strings | Partial credit is deliberate: three of four facts is genuinely better than none, and that signal is how you distinguish "improved" from "failed differently" |
| `not_contains` | All-or-nothing | No partial credit for leaking one secret out of three |
| `regex` | Match | A malformed pattern is reported as a broken **case**, never as a failing agent |
| `json_path` | Fraction of checks | JSON-compared, not `===`, so `{a:1}` equals `{a:1}` |
| `budget` | Latency and cost, **continuously** | 1.05× over and 10× over are both failures but not the same failure |
| `llm_judge` | Rubric, 0–100 | See below |

`budget` is the one that makes §0.5 answerable in the direction that decides things. "Did
compaction improve the answer" is one question; "did it make the run cheaper without making
the answer worse" is the one that determines whether to keep it.

### The judge and §16.1

§16.1 Constraint 1 is absolute: *"Traces, metrics, **evals**, and prompt/completion logs
never leave our perimeter. Self-hosted without exception."*

A judge sends the case input **and** the agent's completion to a model. If that model is
external, the eval corpus has left the perimeter. So `llm_judge` resolves the judge model
from the registry and **refuses any model whose residency is `external`**, regardless of
what the suite names. The refusal is not configurable.

That means the judge is unusable in this deployment, because no self-hosted judge model is
registered. **That is the correct failure.** The alternative is a harness that quietly
ships evaluation data to a vendor so a suite looks complete. The refusal is tested.

It is also not the default grader. A suite judged entirely by a model measures the judge as
much as the agent, and when the number moves nobody can say which one moved.

## The promotion gate (§15.5)

```
AgentVersion → Evaluate → gate → Deploy (canary) → Production feedback
                  ▲                                        │
                  └──────────── promote │ rollback ─────────┘
```

The gate is only real if it can refuse. Two properties:

**The eval run must name *this* version.** Not "a recent passing run for this agent" —
that is the failure where v4 ships on v3's evidence, producing a green check for an
untested artefact, which is worse than no gate at all. Tested.

**An ungated agent is reported as ungated, not as passing.** `gated: false` and
`passed: true` are different facts; collapsing them means nobody can enumerate which
agents lack a gate.

Overrides exist and are **recorded**. Without one, a gate gets bypassed by someone editing
the table during an incident and nobody ever knows. With one, `gate_overridden_by` and
`gate_override_reason` are on the deployment row, a CHECK constraint makes a reason
mandatory, and an override the gate did not authorise is refused outright — a gate anyone
can talk past by supplying a string is decoration.

Rollback derives its target from deployment history rather than taking it as a parameter:
nobody should have to correctly recall a version id under incident pressure. It writes a
**new** row rather than reviving the retired one, because the deployment record is history
and a post-incident review needs to see that a rollback happened.

## The §0.5 ledger

`GET /v1/evals/mechanisms` lists **every** mechanism, including those with no suite at all:

```
summarization      no_eval
compaction         no_eval
memory_tiers       no_eval
planning_scaffold  no_eval
sub_agents         no_eval
retrieval          no_eval
eviction           no_eval
skills             no_eval
knowledge          mechanism_justified      settlement-knowledge
model_cache        no_eval
peers              no_eval
```

The absent ones are the point. "Each mechanism has an eval demonstrating current benefit"
is unauditable without a list of the ones that do not, and `no_eval` means *the mechanism
is retained on faith*.

Only runs that actually answered the mechanism question count toward a verdict. An earlier
version of this ledger took the latest run of the suite by time, and a later plain pass/fail
run silently overwrote a standing `mechanism_justified` with `failed` — which reads as "the
mechanism was disproved" when nobody had re-tested it. `never_compared` is distinct from
`no_eval` because the fix differs: one needs a suite written, the other needs it run with
`compareMechanism`.

## Verified: does the knowledge base earn its place?

Against live Postgres and `gemini-2.5-flash`, six cases, mechanism `knowledge`:

| | With KB | Without KB |
|---|---|---|
| Score | **1.0000** | 0.3333 |
| Cases passed | 6/6 | 2/6 |
| p50 latency | 3,166 ms | 9,693 ms |
| Total cost | **635 µm** | 10,177 µm |

```
verdict:   mechanism_justified
rationale: "knowledge" improved the score by 0.6667 (1.0000 with, 0.3333 without) over
           6 comparable cases, clearing the required margin of 0.05.
```

Per-case, without the KB: it missed `T+2`, `T+5`, `paused`, and the Europe phrasing, and
passed only the two cases that needed no corpus — including `06-no-invention`, where the
right answer is to decline.

**The cost column is the finding.** The knowledge base made runs **16× cheaper** and 3×
faster, not just more accurate: ungrounded, the model produces long hedged prose exploring
possibilities. This is the opposite of the §0.5 worry about compensating mechanisms — and
it is only visible because eval runs are real runs whose cost is metered. A harness that
mocked execution would have reported the accuracy win and missed this entirely.

The gate then behaved correctly end to end: promotion of a version with **no** run for it
was blocked; a registered version scoring 0.3333 against a 0.9 gate was blocked; an
unauthorised override was refused with `capability_denied`; the passing version promoted at
`canaryPercent: 10` with `state: rolling`; an authorised override was recorded with its
reason; and rollback returned to the previous version without being told which.

## What this does not do

Stated plainly, because a harness that overstates its rigour is worse than none:

- **No significance testing.** The case-count floor is a guardrail, not statistics.
- **No variance handling.** Each case runs **once**. A non-deterministic agent will produce
  a different score on a re-run, and this harness cannot tell that from a regression.
  Repeated trials per case are the obvious next step.
- **No production-traffic evaluation.** §15.5's "production feedback" arrow is served by
  the existing `feedback` table and its rollup, not by this harness. Shadow deployment is
  recorded (`shadow_from_version_id`) but nothing yet routes traffic to it.
- **No judge available**, per §16.1 above.
