# Skills and knowledge

> Asked as one question — *"also need to support skills and knowledge base (or is it same
> like vector search)"* — and answered as two, because the honest answer is "half".

## The short answer

**Retrieval is the same mechanism.** A knowledge chunk and a semantic memory record are
both embedded by the same `Embedder` and ranked by cosine distance over pgvector. There is
one embedding contract in this system, and `EMBEDDING_DIMENSIONS` lives on the port rather
than in an adapter precisely so a second index cannot quietly acquire a second one.

**Lifecycle is not the same**, which is why knowledge is not simply more rows in
`memory_records`:

| | Memory record | Knowledge chunk |
|---|---|---|
| Origin | Learned by a run | Authored, ingested from a document |
| Owner | One tenant | The namespace |
| Correction | Superseded by a newer record | Re-ingest the document; old chunks are replaced |
| Deletion | Decays, expires, is erased on request | Cascades from its document |
| Carries | `salience`, `access_count`, `superseded_by`, provenance | `document_id`, `ord`, `content_hash` |

Overloading `memory_records` would have meant a `superseded_by` that never fires, a
`salience` nobody sets, and no way to answer *"which document did this come from"* — the
first question anyone asks of a knowledge base.

**A skill is neither.** It is control-plane content: a named, versioned, immutable unit of
procedural instruction that may carry tools and collections with it.

## Why skills are a registry and not a prompt fragment

The tempting version is a `skills` table with an `instructions` column you edit in place,
and an agent that references skills by name. It is wrong in a way that only shows up
later.

A skill can carry tools. If skills are mutable and bound by name, then editing one changes
both the behaviour **and the authority** of every published agent that references it — with
no new spec hash, no admission decision, and no record of who approved the widening. The
run that then does something nobody expected is attributed to an agent version whose stored
spec never changed. That is exactly the situation §17.5 exists to prevent, arriving through
a side door.

So:

- Publishing mints a new **immutable version**. Editing a skill is publishing v(n+1).
- An agent pins the **version**, resolved once at admission and stored in
  `agent_version_skills`. `ResolvedVersion.load()` reads the pin table, never the spec blob
  — reading the blob would re-resolve on every load and silently move a running agent onto
  newer instructions.
- Deprecating a version makes it unselectable **by name** while agents already pinned to it
  keep running. Cascading deprecation into existing pins would be a deletion wearing a
  softer word.

## The capability argument

A skill's tools are indistinguishable from directly-named ones at call time, so they are
made indistinguishable at admission time too. `AdmissionService` builds the **union** of
`spec.tools` and every tool the resolved skills bring, then intersects the whole union with
the caller's grants (§16.2).

Without that, "attach the skill" is a capability-laundering path around a tool the caller
was refused:

```
POST /v1/runs { tools: ["payments.refund"] }        → refused, no grant
POST /v1/runs { skills: ["refund-helper"] }         → would have worked
```

The rejection also names the skill that pulled the tool in — `no grant for
payments.refund` is baffling to an author whose spec never mentioned payments.refund.

Collections are grantable for the same reason in the read direction: a skill must not
smuggle access to a corpus either. `test/skills.spec.ts` covers both.

**Grants are minted at publish/create time.** Publishing into your own namespace *is* the
act of authorising it there, so requiring a second call afterwards would just be a step
every caller performs unconditionally. The grant's value is **revocation** — switching a
skill off without deleting it — and the skill's *tools* are still checked separately, which
is where the laundering risk actually lives.

## What the platform does not do

It does not prepend skill text to the prompt. Skills and knowledge snippets are passed to
the `FrameworkAdapter` in their own fields, and what to do with them is the framework's
decision.

This is §0.5 applied consistently: every compensating mechanism is individually disableable
and one that cannot be shown to help should be removed. A platform that injects the text
unconditionally, which no framework can decline, makes "did the skill help" unanswerable —
and a mechanism whose benefit cannot be measured is one nobody can ever justify removing.

The three fields stay separate for the same reason:

- `skills` — a procedure the author wants followed
- `knowledge` — reference material to reason over
- `recalled` — what this tenant's history suggests

Merging them loses the distinction the trace needs. "The agent remembered something about
this tenant", "the agent looked something up in the manual", and "the agent was told to do
this" fail in different ways and are fixed in different places.

## Structural invariants

Enforced by the database, not by a service method someone can forget to call:

- `knowledge_chunks (document_id, collection_id)` is a **composite FK** to
  `knowledge_documents (id, collection_id)`. A chunk whose collection disagrees with its
  document's is not merely wrong, it is unwritable — a corpus leaking across a boundary is
  the failure the namespace scoping exists to prevent.
- `skill_version_collections` and `agent_version_skills` carry `namespace_id` in composite
  FKs, so citing another namespace's skill or corpus is unrepresentable, the same trick
  `agent_version_sub_agents` uses for §13.3.
- `agent_version_skills.skill_version_id` is `ON DELETE RESTRICT`. Deleting a skill out
  from under a pinned agent is what the pin exists to prevent. (Test teardown has to unpin
  first — that is the constraint working.)
- `agent_version_skills.ord` is **stored**, not derived. Skill order is part of the spec's
  meaning, and a join returns whatever the planner felt like — which is how sub-agent
  ordering silently inverted once already.

## Ingestion

`POST /v1/knowledge/collections/{id}/documents` chunks, embeds and indexes synchronously.

Idempotent on content: `content_hash` covers the body **and** the chunking parameters. The
obvious way to keep a knowledge base fresh is a nightly job that re-pushes every source,
and that must not re-embed an unchanged corpus every night — it costs real money. Re-pushing
identical bytes returns `unchanged: true` and touches nothing. Re-chunking the same bytes
with different parameters is *not* unchanged, because the index genuinely differs.

Embedding happens **before** the transaction opens. It is a network call to a third party
with third-party latency, and holding a write transaction across it puts an external
service's p99 into this database's lock-wait time.

Re-ingestion **replaces** a document's chunks rather than upserting them. An upsert keyed on
`(document_id, ord)` leaves orphans whenever a new version produces fewer chunks: the tail
of the old version stays in the index and keeps ranking, so the corpus answers from text the
document no longer contains. That failure is silent and permanent.

`GET .../search` exists so a corpus can be evaluated **without running an agent**. "The
agent gave a bad answer" has at least two causes — retrieval surfaced the wrong passages, or
the model misused the right ones — and they are fixed in different places.

## Chunking

Deterministic, and that is the point rather than an incidental property: the same bytes must
produce the same chunks, or `content_hash` stops meaning "already ingested".

Paragraphs first, then sentences, then a hard cut. Splitting mid-sentence is a real quality
loss — the passage that answers the question ends up half in one embedding and half in
another, and neither ranks — so it is the last resort, not the strategy. Overlap exists for
the same failure: a fact stated across a paragraph break belongs to both sides of it.

One tradeoff is explicit in the code: when a unit already fills the budget on its own, the
overlap is dropped rather than the budget broken. A chunk larger than the caller asked for
is one their context window may not hold.

## Verified end to end

Against live Postgres, the real Gemini embedder (`gemini-embedding-001` at 768 dims) and
`google/gemini-2.5-flash`:

```
corpus:  "International card settlement happens on T+5 business days."
skill:   "State the exact number of business days. If the material does not cover the
          card type asked about, say so rather than estimating."

ask:     "I sell to customers in Europe. When does that money actually reach my bank?"
answer:  "International card settlement happens on T+5 business days."        ← semantic, not keyword

ask:     "When do UPI collections settle to my account?"
answer:  "The reference material does not cover UPI collections."             ← the skill's rule held
```

The agent pinned `settlement-answers@1`; v2 of that skill had already been published with
different instructions and did not affect the run.
