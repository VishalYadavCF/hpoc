import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import type { LineageNodeKind } from '../../platform/persistence/schema.generated.js';
import type { RelationEdge, RelationIndex } from '../../domain/ports/memory.port.js';

/**
 * The graph seam, backed by `lineage_edges`.
 *
 * A recursive CTE is what a property-graph database would do natively; keeping traversal
 * behind this port means swapping to one is an adapter, not a rewrite of every caller
 * that asks "where did this come from" (§15.3).
 */
@Injectable()
export class PostgresRelationIndex implements RelationIndex {
  readonly id = 'postgres-lineage';

  constructor(@Inject(DB) private readonly db: Db) {}

  async relate(
    tx: Tx,
    edge: RelationEdge & { orgId: string; tenantRef: string; runId?: string | null },
  ): Promise<void> {
    await tx
      .insertInto('lineage_edges')
      .values({
        org_id: edge.orgId,
        tenant_ref: edge.tenantRef,
        // The port speaks plain strings so a graph store can replace this adapter;
        // the lineage_node_kind enum rejects an unknown kind at insert.
        derived_kind: edge.fromKind as LineageNodeKind,
        derived_id: edge.fromId,
        source_kind: edge.toKind as LineageNodeKind,
        source_id: edge.toId,
        relation: edge.relation,
        run_id: edge.runId ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async neighbours(
    node: { kind: string; id: string },
    direction: 'out' | 'in',
    depth = 1,
  ): Promise<RelationEdge[]> {
    // Depth is bounded by the caller and enforced here: an unbounded traversal over a
    // cyclic provenance graph does not terminate.
    const maxDepth = Math.min(Math.max(depth, 1), 10);
    const rows =
      direction === 'out'
        ? await sql<{ derived_kind: string; derived_id: string; source_kind: string; source_id: string; relation: string }>`
            WITH RECURSIVE walk AS (
              SELECT derived_kind, derived_id, source_kind, source_id, relation, 1 AS d
                FROM lineage_edges
               WHERE derived_kind = ${node.kind} AND derived_id = ${node.id}::uuid
              UNION ALL
              SELECT e.derived_kind, e.derived_id, e.source_kind, e.source_id, e.relation, w.d + 1
                FROM lineage_edges e JOIN walk w
                  ON e.derived_kind = w.source_kind AND e.derived_id = w.source_id
               WHERE w.d < ${maxDepth}
            )
            SELECT DISTINCT derived_kind, derived_id, source_kind, source_id, relation FROM walk
          `.execute(this.db)
        : await sql<{ derived_kind: string; derived_id: string; source_kind: string; source_id: string; relation: string }>`
            SELECT derived_kind, derived_id, source_kind, source_id, relation
              FROM lineage_edges
             WHERE source_kind = ${node.kind} AND source_id = ${node.id}::uuid
          `.execute(this.db);

    return rows.rows.map((r) => ({
      fromKind: r.derived_kind,
      fromId: r.derived_id,
      toKind: r.source_kind,
      toId: r.source_id,
      relation: r.relation,
    }));
  }
}
