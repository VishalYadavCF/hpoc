# Prisma in this repo

**The SQL migrations in `db/migrations/` are the single source of truth.** Prisma is a
*generated artifact* — a readable, typed model of the schema for exploration, `prisma
studio`, and anyone who prefers reading a Prisma schema to reading DDL.

## Why the runtime uses Kysely

The schema leans on things Prisma cannot express or must ignore:

| Feature | Used for | Prisma |
|---|---|---|
| Partitioned tables | `events`, `usage_ledger`, `audit_log` retention by DROP | not modelled |
| Partial unique indexes | ephemeral-only spec-hash dedup (migration 0007) | not modelled |
| `CHECK` constraints | §8.3 effect contracts, §13.3 namespaces, §4.6 depth | not modelled |
| Composite FKs | making a cross-namespace sub-agent unrepresentable | not modelled |
| `FOR UPDATE SKIP LOCKED` | the lease claim (§4.4) | raw SQL anyway |
| Enum arrays, `vector` | effects, embeddings | partial |

Those constraints are not decoration — they are where §8.3 and §13.3 are *enforced*. An
ORM that silently drops them from its model would make `prisma migrate` a schema-corrupting
operation.

## Keeping it honest

```bash
npm run db:prisma:sync     # regenerate schema.prisma FROM the migrated database
```

`prisma db pull` introspects the live database, so the Prisma schema can only ever be
downstream of the migrations. **Never run `prisma migrate dev`** against this project: it
would try to make the database match the Prisma file, which is backwards, and would drop
every constraint Prisma cannot represent.

CI runs the sync and fails if it produces a diff — so a migration that lands without
regenerating is caught rather than left to rot.

## db/schema.sql is checked, not trusted

`db/schema.sql` is documentation — the readable whole-schema reference — while
`db/migrations/` is what actually runs. Documentation that can drift silently is worse
than none, because it gets trusted.

It had drifted since migration **0005**. By the time it was checked, the reference was
missing a whole table (`memory_sharing_policies`), fourteen columns, three CHECK
constraints, twelve indexes, and — worst — `run_queue.lease_epoch`, the fencing token that
is the single most load-bearing column in the queue. It also *disagreed* in two places
rather than merely lagging: it declared `memory_embeddings.model_id` as
`uuid REFERENCES models(id)` when the column is a `text` embedder identity with no FK, and
`vector(1536)` where the real width is 768.

Two of those gaps were self-inflicted in a specific way worth naming: an ALTER-based
migration was documented in `schema.sql` as a **commented-out** `ALTER TABLE`. That reads
as documentation and is invisible to any diff, so the reference silently stopped matching.

`npm run db:drift` (in `verify`) now rebuilds a scratch database from `schema.sql` and
diffs it against the migrated one on columns, constraints and indexes. Auto-created
partitions and extension-owned relations are excluded — they exist by operation, not by
declaration.

**The rule this enforces:** a migration's changes belong in `schema.sql` as real DDL
inside the `CREATE TABLE`, never as a commented ALTER.
