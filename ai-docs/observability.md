# Observability

Implements §15. Code in `src/domain/observability/`, routes on `ObservabilityController`.

Built for one loop: **observe what's bad → change something → verify it improved.** Every
aggregate groups by *agent version*, because versions are immutable — that is what makes
"did v3 actually beat v2" answerable instead of hoped for.

## What it answers

| Question | Route |
|---|---|
| What happened in this run, and where did the time go? | `GET /v1/runs/{id}/trace` |
| What happened across this whole conversation? | `GET /v1/threads/{id}/trace` |
| What happened across every agent in one request? | `GET /v1/traces/{traceId}` |
| Where did this answer come from? | `GET /v1/lineage/{kind}/{id}` |
| Is the new version better than the old one? | `GET /v1/analytics/versions` |
| Is it slow, and is it *our* slowness? | `GET /v1/analytics/latency` |
| Which tools fail, and how often? | `GET /v1/analytics/tools` |
| Is memory earning its place (§0.5)? | `GET /v1/analytics/memory` |
| How long do humans take to approve? | `GET /v1/analytics/interactions` |
| What do users think? | `POST /v1/feedback` · `GET /v1/feedback/summary` |

## Latency attribution is the part that matters

Wall time minus step time is **not** overhead. It is queue wait, plus human wait, plus
genuine overhead — and conflating them sends people optimising the wrong thing. A trace
breaks it out:

```json
"latency": { "queueWaitMs": 38, "modelMs": 7, "toolMs": 37, "humanWaitMs": 0, "unaccountedMs": 44 }
```

**This found a real bug within minutes of existing.** The first trace read
`queueWaitMs: 907` against `modelMs: 7`. The worker was polling every 500ms while the
`run_ready` NOTIFY channel it should have been listening on went unused — so every
conversational turn carried roughly half a poll interval of pure, avoidable latency.
Wiring the listener took queue wait from ~900ms to **p50 38ms / p95 56ms**. The poll
remains as a floor, because a NOTIFY can be lost across a listener reconnect and a run
nothing wakes for would otherwise sit forever.

Fixing that exposed a second bug: durations went *negative*. `queued_at` is written by
Postgres and `started_at` was written by Node, and the two clocks differ by ~60ms. **In a
distributed system a duration must be measured against one clock, and the database is the
only clock every worker shares** — so every timestamp that gets differenced is now
`sql\`now()\``. Trace durations are also clamped at zero, so a future clock problem
surfaces as a suspicious zero rather than a nonsensical negative.

## Feedback is bound to a version, not supplied by the caller

`POST /v1/feedback` resolves the agent version from the run. A caller-supplied version
could attribute a complaint to the wrong release — and that number is exactly what a
promotion or rollback decision reads. Feedback on a run the caller cannot see is a 404,
not an orphan row that would silently skew someone else's comparison.

Corrections (`correction: { expected: ... }`) are tracked separately in the summary. They
are the highest-signal feedback there is: someone cared enough to say what the right answer
was, which is also a ready-made eval case once the eval harness exists.

## The honest limit on memory effectiveness

`GET /v1/analytics/memory` splits runs by whether their version enabled memory and compares
success rate, steps, cost, latency and rating. **It is observational, not randomised** —
nothing assigns memory; agents choose it, so the comparison is confounded by workload. The
response says so in a `caveat` field, deliberately, because a number like this gets quoted.

It is enough to notice a mechanism is *not* helping. It is not enough to conclude that it
is. §0.5 asks each compensating mechanism to demonstrate benefit, and demonstrating
requires the eval harness (§15.5), which is not built.

## Not built

- **Eval harness and promotion gates** (§15.5). The tables exist (`eval_suites`,
  `eval_cases`, `eval_runs`, `eval_case_results`); nothing drives them. This is what turns
  the memory question above from observational into causal, and what makes canary
  promotion a gate rather than a hope.
- **OpenTelemetry export** (§15.2). Trace, span and causation ids are recorded on every
  event, but nothing exports them to a collector, so cross-service correlation stops at
  our boundary.
- **Continuous aggregates.** Analytics queries scan; ADR 0001 says the answer at volume is
  Timescale compression plus continuous aggregates, not a new datastore.

---

## The console (`GET /ui`)

A self-hosted trace and feedback console, served from the API process.

§16.1 Constraint 1 is absolute — prompts, conversations, tool calls and execution metadata
must not reach an external telemetry vendor. That rules out a hosted observability product,
which is *why* this exists rather than being a nice-to-have.

Served from the API rather than built as a separate app on purpose: it reads the same
tenant-scoped routes any other client does, so it can never see anything a caller could
not, and there is no second deployment to keep in step.

| Tab | Shows |
|---|---|
| **Runs** | Recent runs across threads; click one for a latency waterfall and its steps |
| **Analytics** | Success and latency **per agent version**, where the time goes, tool health, memory effectiveness with its caveat, feedback rollup |
| **Ops** | Subsystem health and open dead letters with failure history |

The waterfall splits queue wait from model, tool and human time — the split that found the
900ms poll bug. It is a *console*, not a dashboard product: no alerting, no saved views,
no sharing. Those are where a real observability vendor earns its money, and this is
deliberately the least that answers "what happened and is it getting better".

## Prometheus

`GET /metrics` on each process — api `:3000`, worker `:3001`. Histograms carry native
buckets (`_bucket`/`_sum`/`_count`), chosen for this system's shape: sub-100ms is queue and
platform overhead, 100ms–5s is a model call, past 30s is a long tool or a human.

**Labels are route templates, never concrete ids.** `route="/v1/runs/:id"`, not
`route="/v1/runs/<uuid>"` — per-id labels are unbounded cardinality and the fastest way to
take a Prometheus server down. A test asserts this rather than trusting it.

Traces stay in Postgres and are read through `/v1/runs/{id}/trace`; Prometheus carries
aggregates only. OTLP export to a self-hosted collector remains open.
