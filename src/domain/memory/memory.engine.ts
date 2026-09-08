import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import type { Tx } from '../../platform/persistence/database.js';
import { PlatformError } from '../errors/platform.errors.js';
import {
  EMBEDDER, MEMORY_CACHE, MEMORY_STORE, RELATION_INDEX, SUMMARIZER, VECTOR_INDEX,
  type Embedder, type MemoryCache, type MemoryFilter, type MemoryRecord, type MemoryStore,
  type MemoryTier, type RelationIndex, type ScopeRef, type Summarizer, type VectorIndex,
} from '../ports/memory.port.js';

export interface SharingPolicy {
  id: string;
  tiers: MemoryTier[];
  redactionPolicy: string;
}

export interface StoreInput {
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  tier: MemoryTier;
  scopeRef: ScopeRef;
  content?: string | null;
  structured?: unknown;
  artifactId?: string | null;
  provenance: MemoryRecord['provenance'];
  /** §6.3: for conversational and episodic rows, whether the user actually received it. */
  delivered?: boolean | null;
  trusted?: boolean;
  salience?: number;
  ttlSeconds?: number | null;
  sourceRunId?: string | null;
  derivedFrom?: { kind: string; id: string }[];
  /**
   * Admit this record into the cross-tenant pool (§6.2).
   *
   * The CALLER asks; the engine still checks the namespace has an enabled policy covering
   * the tier. A consuming service deciding to share its own merchants' derived data is a
   * decision only it can make — and one the platform must not make for it.
   */
  share?: boolean;
}

export interface RecallQuery {
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  text?: string;
  tiers?: MemoryTier[];
  scopeRef?: Partial<ScopeRef>;
  trustedOnly?: boolean;
  limit?: number;
  /** Include the namespace's shared pool alongside this tenant's own records. */
  includeShared?: boolean;
}

export interface Recalled extends MemoryRecord {
  score: number;
}

/** Tiers whose content is worth putting in a vector index at all. */
const EMBEDDED_TIERS: MemoryTier[] = ['semantic', 'episodic', 'procedural'];
const RECALL_CACHE_TTL_MS = 5_000;

/**
 * §6. A first-class subsystem, not a chat-history table.
 *
 * The engine owns POLICY -- what gets embedded, how results are ranked, what may be
 * promoted, when something decays -- and owns no storage. Every store is behind a port
 * (`memory.port.ts`), so Postgres, pgvector, the in-process cache and the lineage graph
 * are all swappable without this file changing.
 *
 * Subject to §0.5: every tier is individually disableable per agent, and a tier that
 * cannot be shown to help should be turned off rather than tolerated.
 */
@Injectable()
export class MemoryEngine {
  private readonly log = new Logger(MemoryEngine.name);

  constructor(
    private readonly uow: UnitOfWork,
    @Inject(MEMORY_STORE) private readonly store: MemoryStore,
    @Inject(VECTOR_INDEX) private readonly vectors: VectorIndex,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(MEMORY_CACHE) private readonly cache: MemoryCache,
    @Inject(RELATION_INDEX) private readonly relations: RelationIndex,
    @Inject(SUMMARIZER) private readonly summarizer: Summarizer,
  ) {}

  describe(): Record<string, string> {
    return {
      store: this.store.id,
      vectorIndex: this.vectors.id,
      embedder: this.embedder.id,
      cache: this.cache.id,
      relationIndex: this.relations.id,
      summarizer: this.summarizer.id,
    };
  }

  /** The namespace's sharing policy, if one is enabled. Cached per call, not per process. */
  async sharingPolicy(orgId: string, namespaceId: string): Promise<SharingPolicy | null> {
    const row = await this.store.sharingPolicy?.(orgId, namespaceId);
    return row ?? null;
  }

  async store_(input: StoreInput, existingTx?: Tx): Promise<string> {
    const policy = input.share
      ? await this.sharingPolicy(input.orgId, input.namespaceId)
      : null;

    if (input.share && !policy) {
      // Refused, not silently downgraded to private. A caller that believed it was
      // contributing to a shared corpus and was not would find out much later.
      throw new PlatformError(
        'capability_denied',
        'Sharing was requested but this namespace has no enabled memory sharing policy',
        { hint: 'POST /v1/memory/sharing to enable it' },
      );
    }
    if (policy && !policy.tiers.includes(input.tier)) {
      throw new PlatformError(
        'capability_denied',
        `The sharing policy does not cover the "${input.tier}" tier`,
        { tier: input.tier, covered: policy.tiers },
      );
    }

    const run = async (tx: Tx): Promise<string> => {
      const id = await this.store.put(tx, {
        orgId: input.orgId,
        namespaceId: input.namespaceId,
        tenantRef: input.tenantRef,
        tier: input.tier,
        scope: input.scopeRef.scope,
        scopeRef: input.scopeRef,
        content: input.content ?? null,
        structured: input.structured ?? null,
        artifactId: input.artifactId ?? null,
        provenance: input.provenance,
        // §6.4: external tool output and peer results are untrusted unless something
        // explicitly vouched for them. Defaulting to trusted is how unverified peer
        // assertions get promoted into semantic memory.
        trusted: input.trusted ?? isFirstParty(input.provenance),
        delivered: input.delivered ?? null,
        salience: input.salience ?? 0,
        supersededBy: null,
        expiresAt: input.ttlSeconds ? new Date(Date.now() + input.ttlSeconds * 1000) : null,
        shared: Boolean(policy),
        sharingPolicyId: policy?.id ?? null,
        // §15.3: which tenant this came FROM stays recorded even when the row is
        // readable by others. Redaction is what makes provenance hard, so it must not
        // also be what erases it.
        sourceTenantRef: policy ? input.tenantRef : null,
      });

      const text = input.content ?? (input.structured ? JSON.stringify(input.structured) : '');
      if (EMBEDDED_TIERS.includes(input.tier) && text.length > 0) {
        const [vector] = await this.embedder.embed([text]);
        await this.vectors.upsert(tx, id, this.embedder.id, vector!);
      }

      // §15.3 lineage: provenance is traversable, not merely tagged.
      for (const source of input.derivedFrom ?? []) {
        await this.relations.relate(tx, {
          orgId: input.orgId,
          tenantRef: input.tenantRef,
          fromKind: 'memory',
          fromId: id,
          toKind: source.kind,
          toId: source.id,
          relation: 'derived_from',
          runId: input.sourceRunId ?? null,
        });
      }

      return id;
    };

    const id = existingTx ? await run(existingTx) : await this.uow.run(run);
    await this.cache.invalidate(scopeKey(input.orgId, input.namespaceId, input.tenantRef));
    return id;
  }

  /**
   * Hybrid recall: structured filter first, then vector ranking over what survives it.
   *
   * Filter-then-rank rather than rank-then-filter, because a tenant with a thousand
   * records must not have its results decided by another tenant's million -- and because
   * a scope the caller cannot see must never influence ordering, even invisibly.
   */
  async recall(query: RecallQuery): Promise<Recalled[]> {
    const limit = query.limit ?? 10;
    const filter: MemoryFilter = {
      orgId: query.orgId,
      namespaceId: query.namespaceId,
      tenantRef: query.tenantRef,
      tiers: query.tiers,
      scopeRef: query.scopeRef,
      trustedOnly: query.trustedOnly,
      includeShared: query.includeShared,
      limit: Math.max(limit * 4, 40),
    };

    const key = `${scopeKey(query.orgId, query.namespaceId, query.tenantRef)}|${JSON.stringify({ ...query, orgId: undefined })}`;
    const cached = await this.cache.get<Recalled[]>(key);
    if (cached) return cached;

    let results: Recalled[];

    if (query.text && query.text.trim().length > 0) {
      const [vector] = await this.embedder.embed([query.text]);
      const hits = await this.vectors.search({ vector: vector!, filter, limit: filter.limit! });
      const records = await this.store.byIds(hits.map((h) => h.memoryId));
      const byId = new Map(records.map((r) => [r.id, r]));
      const scoreById = new Map(hits.map((h) => [h.memoryId, h.score]));

      results = hits
        .map((h) => {
          const record = byId.get(h.memoryId);
          return record ? { ...record, score: scoreById.get(h.memoryId) ?? 0 } : null;
        })
        .filter((r): r is Recalled => r !== null)
        .filter((r) => !query.tiers || query.tiers.includes(r.tier))
        .filter((r) => matchesScope(r, query.scopeRef));

      // Vector similarity alone ignores that a record read fifty times is probably more
      // useful than one read once. Salience and use nudge, they do not dominate.
      results.sort((a, b) => rank(b) - rank(a));
    } else {
      const records = await this.store.query(filter);
      results = records.map((r) => ({ ...r, score: 0 }));
    }

    const top = results.slice(0, limit);
    await this.store.touch(top.map((r) => r.id));
    await this.cache.set(key, top, RECALL_CACHE_TTL_MS);
    return top;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.store.get(id);
  }

  /**
   * Lists records by scope and tier, without ranking them.
   *
   * Deliberately NOT `recall`. Recall embeds a query, searches the vector index and
   * returns what is most relevant; this returns what EXISTS, newest first. An operator
   * auditing what the platform remembers about a tenant needs the second — a relevance
   * ranking would silently omit the record they came to find.
   */
  async list(filter: MemoryFilter): Promise<MemoryRecord[]> {
    return this.store.query(filter);
  }

  /**
   * Updates a record's mutable fields.
   *
   * `content` is deliberately NOT among them. A semantic record's embedding was computed
   * from its content, so editing the text in place would leave a vector that points at
   * what the record used to say — retrievable by the old meaning and unfindable by the
   * new one. Correcting a memory is superseding it, which keeps both the correction and
   * what it replaced (§6.4).
   */
  async amend(
    id: string,
    patch: { salience?: number; trusted?: boolean; expiresAt?: Date | null },
  ): Promise<MemoryRecord | null> {
    const existing = await this.store.get(id);
    if (!existing) return null;
    await this.store.update(id, {
      ...(patch.salience !== undefined ? { salience: patch.salience } : {}),
      ...(patch.trusted !== undefined ? { trusted: patch.trusted } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    });
    // Cached recalls for this scope would otherwise keep serving the old trust flag, and
    // §6.4's whole point is that trust is honoured at retrieval time.
    await this.cache.invalidate(scopeKey(existing.orgId, existing.namespaceId, existing.tenantRef));
    return this.store.get(id);
  }

  async forget(id: string): Promise<void> {
    const record = await this.store.get(id);
    await this.vectors.remove(id);
    await this.store.delete(id);
    if (record) {
      await this.cache.invalidate(scopeKey(record.orgId, record.namespaceId, record.tenantRef));
    }
  }

  async forgetScope(filter: MemoryFilter): Promise<number> {
    const n = await this.store.deleteByScope(filter);
    await this.cache.invalidate(scopeKey(filter.orgId, filter.namespaceId, filter.tenantRef));
    return n;
  }

  /**
   * Background consolidation (§6.2): summarise a group of records into one, supersede the
   * originals, and record the lineage.
   *
   * The originals are SUPERSEDED, not deleted. §0.5 warns that forced summarisation which
   * discards detail the model could have used natively is a net negative -- keeping the
   * sources means that harm is recoverable and, more importantly, measurable.
   */
  async consolidate(args: {
    orgId: string;
    namespaceId: string;
    tenantRef: string;
    tier: MemoryTier;
    scopeRef: Partial<ScopeRef>;
    minRecords?: number;
    maxChars?: number;
  }): Promise<{ consolidatedId: string; sourceCount: number } | null> {
    const sources = await this.store.query({
      orgId: args.orgId,
      namespaceId: args.namespaceId,
      tenantRef: args.tenantRef,
      tiers: [args.tier],
      scopeRef: args.scopeRef,
      limit: 200,
    });

    const minimum = args.minRecords ?? 3;
    if (sources.length < minimum) return null;

    const texts = sources.map((s) => s.content ?? JSON.stringify(s.structured)).filter(Boolean);
    const summary = await this.summarizer.summarize(texts as string[], args.maxChars ?? 2_000);
    if (!summary) return null;

    const consolidatedId = await this.uow.run(async (tx) => {
      const id = await this.store.put(tx, {
        orgId: args.orgId,
        namespaceId: args.namespaceId,
        tenantRef: args.tenantRef,
        tier: args.tier,
        scope: (args.scopeRef.scope ?? sources[0]!.scope) as MemoryRecord['scope'],
        scopeRef: { ...sources[0]!.scopeRef, ...args.scopeRef } as ScopeRef,
        content: summary,
        structured: null,
        artifactId: null,
        provenance: 'consolidated',
        // A consolidation of untrusted inputs is itself untrusted. Trust does not
        // launder through summarisation (§6.4).
        trusted: sources.every((s) => s.trusted),
        delivered: null,
        salience: Math.max(...sources.map((s) => s.salience), 0) + 1,
        supersededBy: null,
        expiresAt: null,
      });

      const [vector] = await this.embedder.embed([summary]);
      await this.vectors.upsert(tx, id, this.embedder.id, vector!);

      for (const source of sources) {
        await this.relations.relate(tx, {
          orgId: args.orgId,
          tenantRef: args.tenantRef,
          fromKind: 'memory',
          fromId: id,
          toKind: 'memory',
          toId: source.id,
          relation: 'consolidated_from',
        });
      }
      return id;
    });

    for (const source of sources) {
      await this.store.update(source.id, { supersededBy: consolidatedId });
    }
    await this.cache.invalidate(scopeKey(args.orgId, args.namespaceId, args.tenantRef));

    return { consolidatedId, sourceCount: sources.length };
  }

  /** Where did this memory come from? (§15.3) */
  async provenanceOf(memoryId: string, depth = 3) {
    return this.relations.neighbours({ kind: 'memory', id: memoryId }, 'out', depth);
  }

  async expire(now = new Date()): Promise<number> {
    const n = await this.store.expire(now);
    if (n > 0) this.log.log(`expired ${n} memory record(s)`);
    return n;
  }
}

/** §6.4: first-party by default; anything from outside our boundary is not. */
const isFirstParty = (p: MemoryRecord['provenance']): boolean =>
  p === 'user_input' || p === 'model_output' || p === 'consolidated';

const scopeKey = (orgId: string, namespaceId: string, tenantRef: string): string =>
  `${orgId}:${namespaceId}:${tenantRef}`;

const rank = (r: Recalled): number =>
  r.score + Math.min(r.salience, 5) * 0.02 + Math.min(r.accessCount, 20) * 0.005;

const matchesScope = (r: MemoryRecord, scopeRef?: Partial<ScopeRef>): boolean => {
  if (!scopeRef) return true;
  if (scopeRef.threadId && r.scopeRef.threadId !== scopeRef.threadId) return false;
  if (scopeRef.agentId && r.scopeRef.agentId !== scopeRef.agentId) return false;
  if (scopeRef.userId && r.scopeRef.userId !== scopeRef.userId) return false;
  if (scopeRef.runId && r.scopeRef.runId !== scopeRef.runId) return false;
  return true;
};
