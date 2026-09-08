# Memory engine

Implements §6. Companion to `ai-docs/plans/lld.md`; code in `src/domain/memory/` and
`src/adapters/memory/`.

**The engine owns policy and no storage.** What gets embedded, how results are ranked,
what may be promoted, when something decays — all in `memory.engine.ts`. Every store sits
behind a port, so swapping one changes `adapters.module.ts` and nothing in `src/domain`.

## The six seams

| Port | Today | Intended swaps | Why it is a seam |
|---|---|---|---|
| `MemoryStore` | Postgres | Mongo, DynamoDB | Nothing in the port assumes SQL, joins, or transactions beyond an opaque handle |
| `VectorIndex` | pgvector | Qdrant, Pinecone, Weaviate, pgvector-scale | Takes a *filter* alongside the vector, so pre-filtering is the adapter's problem, not the engine's |
| `Embedder` | deterministic hash, Gemini | OpenAI, Cohere, a local model | Swapping is a re-embed, never a silent config change |
| `MemoryCache` | in-process | Redis, Memcached | Scope-keyed invalidation is in the contract, so a distributed cache can honour it |
| `RelationIndex` | Postgres `lineage_edges` | Neo4j, Neptune, Age | Speaks nodes/edges/traversal, not tables and joins |
| `Summarizer` | extractive | an LLM-backed one | Consolidation's compression step, isolated so it can be measured |

Each is one interface plus one `Symbol` in `src/domain/ports/memory.port.ts`. An adapter is
one class and one line in `adapters.module.ts`. `GET /v1/memory/engine` reports which is
bound, which matters while a swap is in flight.

## Tiers and scopes

Six tiers (§6.1): `working`, `conversational`, `semantic`, `episodic`, `procedural`,
`external`. Only `semantic`, `episodic` and `procedural` are embedded — indexing a working
buffer costs an embedding call per scratch note and buys nothing.

Six scopes (§6.2): `org`, `tenant`, `user`, `agent`, `thread`, `run`. Each has its own
reference column with a `CHECK` matching it to `scope`. A single polymorphic `scope_ref`
would have lost cascade delete — closing a thread must take its thread-scoped memory with
it.

## Rules the code actually enforces

**Trust is derived from provenance, not from the caller.** `user_input`, `model_output`
and `consolidated` default trusted; `tool_output`, `peer_result` and `artifact` do not
(§6.4). Provenance travels with every search result, so a caller can tell first-party
knowledge from hearsay at the point of use. `trustedOnly` filters at retrieval without
deleting anything.

**Trust does not launder through summarisation.** A consolidation of untrusted sources is
untrusted. Summarisation is a compression step, not a trust boundary.

**Consolidation supersedes, never deletes.** §0.5 warns that forced summarisation which
discards detail the model could have used natively is a net negative *and that its harm is
invisible without measurement*. Keeping the sources is what makes it measurable — and
recoverable.

**Only delivered content is remembered.** A run writes conversational and episodic memory
on completion only. A failed run writes nothing. This is §6.3's transcript-fidelity rule
as a write rule: the alternative is an agent later referencing things it never said.

**Filter first, then rank.** A tenant with a thousand records must not have its ordering
decided by another tenant's million, and a scope the caller cannot see must never
influence results even invisibly.

**Memory is a mechanism, not a dependency.** Disabled by default per agent (§0.5). A
recall failure is logged and degrades the answer; it never fails a run that would
otherwise succeed.

## Two properties worth knowing before building on it

**Memory writes are eventually consistent with run completion.** They happen *after* the
terminal transaction, so a memory write can never roll back a completed run. A caller
reading memory the instant a run reports `completed` can miss it — the tests poll for this
reason, and so should you.

**The in-process cache does not invalidate across pods.** A write on one API pod does not
clear another's cache, so the TTL is deliberately 5 seconds and this is only ever a latency
optimisation. Redis is the swap; the port already carries scope-keyed invalidation.

## Embeddings

The column is `vector(768)`. `gemini-embedding-001` is natively 3072 and is truncated via
`outputDimensionality`, then **re-normalised** — a truncated Matryoshka embedding is no
longer unit length, and cosine similarity over unnormalised vectors ranks partly by
magnitude. The index would still return results; they would just be quietly worse.

`DeterministicEmbedder` is the offline default: it hashes token trigrams into buckets, so
it is **lexical, not semantic** — "invoice" and "bill" are as unrelated as "invoice" and
"banana". It exists so indexing, filtering, ranking and decay can be exercised
deterministically in CI, not to produce good recall. `PgVectorIndex` asserts the embedder's
dimension at boot, because vectors from two models are not comparable and a column
accepting both returns nonsense rankings rather than an error.

**Changing embedding model is a migration and a re-embed.** `memory_embeddings` is keyed
by `(memory_id, model_id)` so a new model's vectors land alongside the old ones rather than
replacing them mid-migration — a partial re-embed otherwise leaves the index half in each
vector space.

## API

```
GET    /v1/memory/engine        which adapter is behind each seam
POST   /v1/memory               store a record
POST   /v1/memory/search        hybrid recall
GET    /v1/memory/{id}          read one
GET    /v1/memory/{id}/lineage  traverse provenance (§15.3)
POST   /v1/memory/consolidate   summarise a scope and supersede its sources
DELETE /v1/memory/{id}          forget one, and its vector
DELETE /v1/memory?threadId=…    bulk erasure by scope
```

Bulk delete requires a scope: it refuses to wipe a whole tenant on an empty filter.

## Not built

Cross-tenant shared memory with a redaction policy — the conflict raised in
`client-interactions/02-relay-agent-builder.md`, still the blocking decision for that
consumer. Also: the context engine (§7) that would use recall for compaction and eviction,
per-tier eval harnesses (§0.5 asks each mechanism to demonstrate benefit), and a
non-run credential mint so the embedder can go through the broker rather than the
environment.

---

## Cross-tenant sharing (resolved)

The conflict raised in `client-interactions/02` is settled as **a capability the consuming
service opts into per namespace**, not a platform default. Sharing data derived from a
service's own customers is a decision only that service can make — so the platform provides
the mechanism and refuses to assume the policy.

```
GET    /v1/memory/sharing      what is enabled, and how many records were contributed
POST   /v1/memory/sharing      { tiers, redactionPolicy, enabled }
DELETE /v1/memory/sharing      revoke
```

Four properties make it safe to leave off by default and honest when on:

**Off unless enabled.** A `share: true` write into a namespace with no policy is a **403**,
not a silent downgrade to private — a caller that believed it was contributing to a shared
corpus and was not would find out much later.

**Per tier.** A service can share learned procedures while keeping episodic history
strictly per-tenant. A tier outside the policy is refused with the covered set in the error.

**Reads are explicit.** `includeShared: true` on recall, at both the structured filter and
the vector index. Defaulting to include shared rows would mean a tenant silently reading
another's data.

**Provenance survives.** A shared row records `source_tenant_ref` and the policy id that
admitted it, so §15.3 can still answer "where did this come from" across the tenant
boundary — which is exactly what redaction otherwise makes impossible. A `CHECK` enforces
that a shared row names both; flipping a boolean cannot expose anything on its own.

**Revoking stops reads, not the corpus.** Other tenants may have built on it, so `DELETE`
disables future cross-tenant reads and retains the contributed rows.
