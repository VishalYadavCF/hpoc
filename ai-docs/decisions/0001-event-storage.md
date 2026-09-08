# ADR 0001 — Event storage: Postgres, with a columnar projection later

**Status:** accepted · **Context:** §11.3 requires written justification for any datastore
beyond Postgres and object storage; §20 lists "no datastore beyond Postgres and object
storage without written justification" as a non-goal. This is that justification, or
rather the argument that it is not yet needed.

## The question

Should execution events live in a time-series / LSM store (ClickHouse, Cassandra, Scylla,
Influx) rather than partitioned Postgres, given that they are append-heavy and drive
streaming?

## The premise conflates two workloads

`events` is read two completely different ways, and only one of them is time-series shaped.

| | Streaming / replay | Analytics |
|---|---|---|
| Query | one run's tail, ordered, after a cursor | aggregate across all runs over a window |
| Plan (measured) | Index Scan, 26 buffers, 4 rows | Seq Scan over the whole partition |
| Latency driver | index depth — flat in table size | rows scanned — linear in table size |
| Consumers | SSE clients, replay, time-travel debugging | dashboards, cost reporting, §15.4 |

The first is a **point-range lookup**. It is what SSE, `Last-Event-ID` resume and replay
all do, and it is the only path in the run's hot loop. An LSM store does not make an
indexed 4-row read faster; a columnar store makes it slower, because reconstructing whole
rows is exactly what column storage is bad at.

The second is a genuine scan workload, and it is where row storage loses badly at scale.

## Why an LSM store is wrong for the primary path

**1. The transactional co-write is the guarantee, not an implementation detail.**
§4.5 rests on the event being appended in the *same transaction* as the state change it
records. That is what makes a crash between "the run completed" and "the event exists"
impossible. No external store can join that transaction. The workaround is an outbox —
which makes the event log eventually consistent with the state it describes, and an event
log that can lag its own subject is not a system of record. §0.2's replay guarantee goes
with it.

**2. Per-run total ordering comes from a row lock.**
`UPDATE runs SET last_event_seq = last_event_seq + 1 ... RETURNING` serialises allocation
per run. An LSM store has no cross-row transaction to hang that on, so ordering would need
an external sequencer — a consensus problem this system does not currently have and should
not acquire to solve a storage question.

**3. Push, not poll, drives the tail.**
`LISTEN/NOTIFY` wakes an SSE subscriber the moment an event commits. ClickHouse and
Cassandra have no push primitive, so the streaming path would become polling — adding
latency to the one path that exists to be low-latency. ClickHouse compounds this: it wants
batched inserts and is poor at single-row ones, and batching directly contradicts
"notify the subscriber now".

## Why the writes are not the problem anyway

Roughly 4–10 events per simple run, more for long ones. At **1M runs/day × 20 events =
20M events/day ≈ 230 inserts/sec** — which a single Postgres node handles without
noticing. Insert throughput is not the constraint and will not be first.

**The constraint is retention × analytics.** 20M/day over 90 days is ~1.8B rows, and
scanning that in row storage for a p99-by-agent dashboard is where it hurts. The trigger to
act is *analytical query latency*, not write volume — and that distinction decides which
solution is correct.

## Decision

**Postgres stays the system of record for `events`.** Partitioned by `occurred_at`, per-run
`seq` ordering, retention by DETACH + DROP, replay corpus exported before a partition goes.

**Analytics becomes a derived read model when it needs to be** — a projection fed from the
event log, never a second source of truth. §13.4's rule that "a second event store means
the design has gone wrong" is about a second *system of record*; a derived projection is
ordinary CQRS and does not violate it.

## The cheapest correct next step is already installed

The Postgres image carries **TimescaleDB** and `timescaledb_toolkit`. Converting `events`
and `usage_ledger` to hypertables gives time-based chunking, native columnar compression
(typically 10–20×) and continuous aggregates — **inside Postgres**, so the transactional
co-write, the row lock and `LISTEN/NOTIFY` all survive untouched.

That clears the analytics problem without introducing a datastore at all, which means
§11.3's bar never has to be cleared. Do this before reaching for anything external.

## When to revisit

| Signal | Action |
|---|---|
| Analytical queries slow after Timescale compression + continuous aggregates | Add a ClickHouse projection fed from the outbox. Postgres still owns the log |
| Insert rate sustained above ~5k events/sec on one node | Shard by org, or move the projection off the write path first — measure which is actually saturating |
| Multi-region active-active writes required (§16.5, Phase 5) | Revisit properly: this is the one requirement that genuinely breaks a single-writer Postgres, and it changes the ordering guarantee too |
| Per-run event counts explode (voice frames, thousand-step coding runs) | Do **not** grow the log. §4.3's relaxed tier exists to batch exactly this; per-frame media events do not belong in an audit log |

## What was rejected and why

- **ClickHouse as primary store** — no transactional co-write, no push, poor single-row inserts.
- **Cassandra / Scylla as primary store** — no cross-row transaction for sequence allocation; would require an external sequencer.
- **Dual-write to Postgres and a columnar store** — two systems of record, no way to keep
  them consistent under failure, and replay would have to pick one. This is the specific
  shape §13.4 warns about.
