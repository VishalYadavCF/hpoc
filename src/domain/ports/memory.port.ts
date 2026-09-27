import type { Tx } from '../../platform/persistence/database.js';

export const MEMORY_STORE = Symbol('MemoryStore');
export const VECTOR_INDEX = Symbol('VectorIndex');
export const EMBEDDER = Symbol('Embedder');
export const MEMORY_CACHE = Symbol('MemoryCache');
export const RELATION_INDEX = Symbol('RelationIndex');
export const SUMMARIZER = Symbol('Summarizer');

export type MemoryTier =
  | 'working' | 'conversational' | 'semantic' | 'episodic' | 'procedural' | 'external';
export type MemoryScope = 'org' | 'tenant' | 'user' | 'agent' | 'thread' | 'run';
export type MemoryProvenance =
  | 'user_input' | 'model_output' | 'tool_output' | 'peer_result' | 'artifact' | 'consolidated';

export interface ScopeRef {
  scope: MemoryScope;
  userId?: string | null;
  agentId?: string | null;
  threadId?: string | null;
  runId?: string | null;
}

export interface MemoryRecord {
  id: string;
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  tier: MemoryTier;
  scope: MemoryScope;
  scopeRef: ScopeRef;
  content: string | null;
  structured: unknown;
  artifactId: string | null;
  provenance: MemoryProvenance;
  trusted: boolean;
  delivered: boolean | null;
  salience: number;
  accessCount: number;
  supersededBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** Cross-tenant pool membership (§6.2). False for every record by default. */
  shared?: boolean;
  sharingPolicyId?: string | null;
  sourceTenantRef?: string | null;
}

export interface MemoryFilter {
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  tiers?: MemoryTier[];
  scopes?: MemoryScope[];
  scopeRef?: Partial<ScopeRef>;
  /** §6.4: retrieval may exclude untrusted provenance without deleting it. */
  provenance?: MemoryProvenance[];
  trustedOnly?: boolean;
  includeSuperseded?: boolean;
  /** Widen the read to the namespace's shared pool as well as this tenant's own rows. */
  includeShared?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// The five seams. Each is one interface plus one token; an adapter is one class
// and one line in memory-adapters.module.ts.
// ---------------------------------------------------------------------------

/**
 * Durable record storage. Postgres today; a document store is the obvious alternative,
 * which is why nothing here assumes SQL, joins, or transactions beyond an opaque handle.
 */
export interface MemoryStore {
  readonly id: string;
  put(tx: Tx, record: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt'> & { id?: string }): Promise<string>;
  get(id: string): Promise<MemoryRecord | null>;
  query(filter: MemoryFilter): Promise<MemoryRecord[]>;
  byIds(ids: string[]): Promise<MemoryRecord[]>;
  update(id: string, patch: Partial<Pick<MemoryRecord, 'content' | 'salience' | 'expiresAt' | 'supersededBy' | 'trusted'>>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByScope(filter: MemoryFilter): Promise<number>;
  /** Retrieval feedback: what was read, and how often, is the decay signal. */
  touch(ids: string[]): Promise<void>;
  expire(now: Date): Promise<number>;
  /** Optional: stores that do not support cross-tenant sharing simply omit it. */
  sharingPolicy?(orgId: string, namespaceId: string): Promise<{ id: string; tiers: MemoryTier[]; redactionPolicy: string } | null>;
}

/**
 * Approximate nearest-neighbour search over embeddings.
 *
 * pgvector today. A dedicated vector database is the intended swap, which is why the
 * port takes a filter alongside the vector -- a store that cannot pre-filter by tenant
 * would have to over-fetch and filter in memory, and the port should make that the
 * adapter's problem rather than the engine's.
 */
export interface VectorIndex {
  readonly id: string;
  readonly dimensions: number;
  upsert(tx: Tx, memoryId: string, modelId: string, vector: number[]): Promise<void>;
  search(query: { vector: number[]; filter: MemoryFilter; limit: number }): Promise<{ memoryId: string; score: number }[]>;
  remove(memoryId: string): Promise<void>;
}

/**
 * The one embedding dimension this deployment stores.
 *
 * It lives on the PORT rather than in an adapter because it is a property of the
 * embedding contract, not of pgvector: every Embedder must produce it, and every index
 * that stores vectors -- memory and knowledge alike -- must expect it. Owned by one
 * adapter, the second index would have to import the first, coupling two swappable
 * things that have no business knowing about each other.
 *
 * Changing it is a migration and a re-embed. Vectors from two models are not comparable,
 * so both indexes assert it at boot rather than returning a confidently wrong ranking.
 */
export const EMBEDDING_DIMENSIONS = 768;

/** Text to vector. Swapping embedders is a re-embed, never a silent config change. */
export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Retrieval cache.
 *
 * In-process today, Redis the obvious swap. §10's rule holds here as everywhere: this
 * never sits in the replay path -- a cached retrieval must be indistinguishable from an
 * uncached one in the event log.
 */
export interface MemoryCache {
  readonly id: string;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Invalidated on write to a scope, which is what keeps a cached recall honest. */
  invalidate(scopeKey: string): Promise<void>;
}

export interface RelationEdge {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  relation: string;
}

/**
 * The graph seam (§15.3).
 *
 * Backed by `lineage_edges` in Postgres today. A property-graph database is the intended
 * alternative, so the port speaks nodes/edges/traversal rather than tables and joins.
 */
export interface RelationIndex {
  readonly id: string;
  relate(tx: Tx, edge: RelationEdge & { orgId: string; tenantRef: string; runId?: string | null }): Promise<void>;
  neighbours(node: { kind: string; id: string }, direction: 'out' | 'in', depth?: number): Promise<RelationEdge[]>;
}

/** Consolidation's compression step. Extractive today; an LLM adapter is one class. */
export interface Summarizer {
  readonly id: string;
  summarize(texts: string[], maxChars: number): Promise<string>;
}
