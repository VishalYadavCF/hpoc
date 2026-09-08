# Demo 002 — the Agent Builder

A workspace for planning use case 2: a merchant types a sentence, and we build a
working Relay workflow from it.

This is planning only. No code is written from these documents yet.

## The one-line goal

> "When a cart is abandoned, call the customer and offer a 10% coupon."
> → a valid, tested, activated Relay workflow.

## Why we are re-planning instead of porting

There is a previous attempt at `~/PycharmProjects/relay-agent-builder`
(Python, FastAPI + LangGraph, ~13.7k LOC). It works end to end on a good day.
Its problem was **accuracy** — the generated DSL was often subtly wrong, and
nobody could say by how much, because nothing was measured.

That project also left behind two excellent post-mortems
(`docs/classA_deterministic_dsl_assembly.md`, `docs/classB_learning_and_context.md`).
Those documents already found the root cause. This workspace starts from their
conclusion rather than rediscovering it.

## The documents here

| File | What it answers |
|---|---|
| `01-why-the-last-one-was-inaccurate.md` | What actually went wrong, with the real examples |
| `02-what-the-builder-needs.md` | The parts we have to build, in plain words |
| `03-platform-mapping.md` | Which of those parts the platform already gives us |
| `04-accuracy-plan.md` | How accuracy stops being an opinion and becomes a number |
| `05-open-questions.md` | What we must decide before building |

## Status

Planning. Nothing decided yet. `05-open-questions.md` is the list to work
through together.

## Related reading

- `ai-docs/client-interactions/02-relay-agent-builder.md` — the consumer profile
- `ai-docs/api-spec.md` — the platform API this would call
- `ai-docs/evals.md` — how scoring works on the platform
