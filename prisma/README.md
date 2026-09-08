# Prisma

`prisma/schema.prisma` is the source of truth. `prisma migrate` owns the
database. `db/schema.sql` is **not** applied to the running application
database — it is kept as the design document the datamodel was derived from,
and as the reference the baseline is checked against.

## Everyday use

```bash
npm run db:up            # start Postgres on 5440
npm run db:migrate       # apply pending migrations (prisma migrate deploy)
npm run db:generate      # regenerate the client into src/generated/prisma
npm run db:verify        # assert the database enforces what the design requires
npm run db:studio        # browse the data
```

To change the schema: edit `schema.prisma`, then

```bash
npm run db:migrate:dev   # prisma migrate dev - names and applies a migration
```

## The three carve-outs

Prisma's datamodel cannot express three things this schema depends on. They live
in the baseline migration's `-- BEGIN hand-maintained` block, reapplied by
`prisma/patch-baseline.mjs` whenever that baseline is regenerated.

| Carve-out | Objects | Why Prisma cannot hold it |
|---|---|---|
| CHECK constraints | 36 declared, 38 including the copies Postgres pushes to partitions | No datamodel syntax for them. `db pull` reports them and drops them. |
| Range partitioning | `events`, `usage_ledger`, `audit_log` | `PARTITION BY` is part of `CREATE TABLE`; a plain table cannot be converted by `ALTER`. |
| hnsw index | `memory_embeddings_ann_idx` | `@@index([embedding])` emits a btree index, which pgvector cannot use for ANN search. |

**`migrate dev` does not undo them.** Prisma diffs the datamodel against the
shadow database and simply does not model CHECK constraints or partitioning, so
it neither sees nor removes them. The hnsw index survives because the datamodel
declares an index of the same name on the same column
(`@@index([embedding], map: "memory_embeddings_ann_idx")`) — Prisma matches on
name and column, not access method. **Do not remove that `@@index` line**: with
no index declared, Prisma would see an extra one in the database and drop it.

A fourth item is deliberately *not* a carve-out. The migration begins with

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
```

because `migrate dev` builds its shadow database from `template0` and replays
migrations into it. Anything only `db/postgres/init/00-extensions.sql` did is
absent there, and the first `CITEXT` column fails with `type "citext" does not
exist` — in the shadow database only. The remaining extensions (timescaledb,
pg_cron, the observability set) stay out of migrations: nothing in the datamodel
refers to them, and two need `shared_preload_libraries`, so a migration could
not create them from nothing. They belong to the server, not the schema.

## Regenerating the baseline

Only needed if the baseline itself has to be rebuilt from `db/schema.sql` — not
for ordinary schema changes, which are `migrate dev`.

```bash
# 1. a reference database with db/schema.sql applied, untouched by Prisma
npm run db:reference

# 2. re-derive the datamodel from it
DATABASE_URL="postgresql://hpoc:hpoc@localhost:5440/hpoc_reference" \
  npx prisma db pull

# 3. restore what introspection loses: `vector` comes back without its
#    dimension, and an hnsw index cannot be built on a dimensionless column
#    -> change Unsupported("vector") to Unsupported("vector(1536)")

# 4. regenerate the baseline migration and reapply the carve-outs
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script \
  > prisma/migrations/00000000000000_init/migration.sql
node prisma/patch-baseline.mjs prisma/migrations/00000000000000_init/migration.sql \
  postgresql://hpoc:hpoc@localhost:5440/hpoc_reference

# 5. apply to a clean database and check nothing was lost
npm run db:reset && npm run db:migrate && npm run db:verify
```

Step 5 is the one that matters. `db:verify` does not just count catalog rows —
it inserts rows that the CHECK constraints must reject, and reads the query plan
to confirm the planner actually chooses the hnsw index. A regeneration that
silently dropped the carve-outs would still produce a database with all 54
tables, and only these probes would notice.

## Known differences from `db/schema.sql`

Verified with `npm run db:verify` and a catalog diff against `hpoc_reference`:
tables, columns, CHECK constraints, foreign keys, indexes and enums all match.
Two representational differences remain, neither of which changes behaviour:

- **Unique constraints are unique *indexes*.** `db/schema.sql` produces 33 rows
  in `pg_constraint` with `contype = 'u'`; Prisma produces 0, and the same 33 as
  unique indexes instead. Enforcement is identical and foreign keys resolve
  against either. The one thing that breaks is
  `ON CONFLICT ON CONSTRAINT <name>` — use `ON CONFLICT (columns)`.
- **`_prisma_migrations`** exists in the migrated database and not in the
  reference. That is Prisma's own ledger.
