import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { AdmissionRejected, PlatformError } from '../errors/platform.errors.js';
import {
  A2A_CAPABILITIES,
  A2A_PROTOCOL_VERSION,
  signCard,
  verifyCard,
  type AgentCard,
  type SignedAgentCard,
} from './agent-card.js';

export interface RegisterPeerInput {
  orgId: string;
  namespaceId: string;
  name: string;
  binding: 'local' | 'remote';
  /** Local: the agent, by name, in any namespace of this org — that is the point. */
  localAgentName?: string;
  localAgentNamespace?: string;
  endpointUrl?: string;
  publicKey?: string;
  agentCard?: SignedAgentCard;
  failureMode?: 'contain' | 'propagate';
  timeoutMs?: number;
  inboundTrust?: 'self' | 'delegated_identity';
}

export interface ResolvedPeer {
  id: string;
  name: string;
  binding: 'local' | 'remote';
  localAgentId: string | null;
  endpointUrl: string | null;
  timeoutMs: number;
  failureMode: 'contain' | 'propagate';
}

/**
 * The peer registry (§13.6).
 *
 * Two rules shape it. Capability descriptors are **generated, not registered** — a local
 * peer's card is derived from its agent's current spec, so there is no card column to
 * disagree with the spec. And a remote peer's card is **verified**, against a key held
 * here rather than one carried inside the card.
 */
@Injectable()
export class PeerService {
  private readonly log = new Logger(PeerService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The runtime's own signing key.
   *
   * Read from `A2A_SIGNING_KEY` when present. When absent the process generates an
   * EPHEMERAL key and says so, because the alternatives are worse: shipping a hardcoded
   * key would make every deployment's signature forgeable by anyone with the source, and
   * refusing to start would make signing a hard dependency of running at all. An ephemeral
   * key produces cards that verify within this process and fail across a restart — visibly
   * wrong rather than silently insecure.
   */
  private signingKey(): string {
    const configured = process.env['A2A_SIGNING_KEY'];
    if (configured) return configured.replace(/\\n/g, '\n');
    if (!PeerService.ephemeralKey) {
      const { privateKey } = generateKeyPairSync('ed25519');
      PeerService.ephemeralKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      this.log.warn(
        'A2A_SIGNING_KEY is not set — agent cards are signed with an ephemeral key that ' +
          'does not survive a restart. Set it before any peer relies on the signature.',
      );
    }
    return PeerService.ephemeralKey;
  }
  private static ephemeralKey: string | null = null;

  async register(input: RegisterPeerInput): Promise<{ id: string; name: string }> {
    const rejections: string[] = [];
    let localAgentId: string | null = null;

    if (input.binding === 'local') {
      if (!input.localAgentName) rejections.push('localAgentName: required for a local binding');
      else {
        let q = this.db
          .selectFrom('agents as a')
          .innerJoin('namespaces as n', 'n.id', 'a.namespace_id')
          .select(['a.id', 'a.expose_as_peer'])
          .where('a.org_id', '=', input.orgId)
          .where('a.name', '=', input.localAgentName)
          .where('a.archived_at', 'is', null);
        // Namespace is OPTIONAL here, and that is the difference from sub-agents: §13.3
        // sends cross-namespace invocation over A2A precisely so a peer may live in
        // another team's namespace. Naming one disambiguates; omitting it does not
        // restrict the search to the caller's own.
        if (input.localAgentNamespace) q = q.where('n.slug', '=', input.localAgentNamespace);

        const matches = await q.execute();
        if (matches.length === 0) {
          rejections.push(`localAgentName: no agent "${input.localAgentName}" in this org`);
        } else if (matches.length > 1) {
          rejections.push(
            `localAgentName: "${input.localAgentName}" is ambiguous across ${matches.length} ` +
              `namespaces — pass localAgentNamespace`,
          );
        } else {
          localAgentId = matches[0]!.id;
          if (!matches[0]!.expose_as_peer) {
            rejections.push(
              `localAgentName: "${input.localAgentName}" is not exposed as a peer. ` +
                `Publish a version with a2a.exposeAsPeer = true first.`,
            );
          }
        }
      }
    } else {
      if (!input.endpointUrl) rejections.push('endpointUrl: required for a remote binding');
      if (!input.agentCard) rejections.push('agentCard: required for a remote binding');
      if (!input.publicKey) {
        rejections.push('publicKey: required for a remote binding — a card is only worth what verifies it');
      }
      if (input.endpointUrl && !/^https:\/\//i.test(input.endpointUrl)) {
        // §16.1: a remote peer is egress, and the delegation chain carries user identity
        // across the hop. Plaintext would put it on the wire.
        rejections.push('endpointUrl: must be https');
      }
    }

    if (rejections.length > 0) throw new AdmissionRejected(rejections);

    let verifiedAt: Date | null = null;
    if (input.binding === 'remote' && input.agentCard && input.publicKey) {
      const result = verifyCard(input.agentCard, input.publicKey);
      if (!result.valid) {
        throw new AdmissionRejected([`agentCard: signature verification failed — ${result.reason}`]);
      }
      verifiedAt = new Date();
    }

    const row = await this.db
      .insertInto('peers')
      .values({
        org_id: input.orgId,
        namespace_id: input.namespaceId,
        name: input.name,
        binding: input.binding,
        local_agent_id: localAgentId,
        endpoint_url: input.binding === 'remote' ? (input.endpointUrl ?? null) : null,
        protocol_version: A2A_PROTOCOL_VERSION,
        // A local peer runs here, so it inherits this deployment's residency. A remote one
        // is external by construction — it is someone else's runtime (§16.1).
        residency: input.binding === 'local' ? 'internal' : 'external',
        agent_card: input.agentCard ? JSON.stringify(input.agentCard) : null,
        card_signature: input.agentCard?.signature.value ?? null,
        card_verified_at: verifiedAt,
        public_key: input.binding === 'remote' ? (input.publicKey ?? null) : null,
        card_fetched_at: input.agentCard ? new Date() : null,
        failure_mode: input.failureMode ?? 'contain',
        timeout_ms: input.timeoutMs ?? 300_000,
        inbound_trust: input.inboundTrust ?? 'self',
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'name']).doUpdateSet({
          endpoint_url: input.binding === 'remote' ? (input.endpointUrl ?? null) : null,
          failure_mode: input.failureMode ?? 'contain',
          timeout_ms: input.timeoutMs ?? 300_000,
        }),
      )
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
    return row;
  }

  async list(orgId: string) {
    return this.db
      .selectFrom('peers')
      .select([
        'id', 'name', 'binding', 'endpoint_url', 'protocol_version', 'residency',
        'status', 'failure_mode', 'timeout_ms', 'card_verified_at', 'inbound_trust',
      ])
      .where('org_id', '=', orgId)
      .orderBy('name')
      .execute();
  }

  async resolve(orgId: string, names: string[]): Promise<{ resolved: ResolvedPeer[]; rejections: string[] }> {
    if (names.length === 0) return { resolved: [], rejections: [] };
    const rows = await this.db
      .selectFrom('peers')
      .select(['id', 'name', 'binding', 'local_agent_id', 'endpoint_url', 'timeout_ms', 'failure_mode', 'status'])
      .where('org_id', '=', orgId)
      .where('name', 'in', names)
      .execute();

    const found = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
    const rejections: string[] = [];
    const resolved: ResolvedPeer[] = [];
    for (const name of names) {
      const row = found.get(name.toLowerCase());
      if (!row) {
        rejections.push(`peers: "${name}" is not in the peer registry`);
        continue;
      }
      if (row.status !== 'active') {
        rejections.push(`peers: "${name}" is ${row.status}`);
        continue;
      }
      resolved.push({
        id: row.id,
        name: row.name,
        binding: row.binding,
        localAgentId: row.local_agent_id,
        endpointUrl: row.endpoint_url,
        timeoutMs: row.timeout_ms,
        failureMode: row.failure_mode,
      });
    }
    return { resolved, rejections };
  }

  /**
   * Derives and signs the card for one exposed agent (§13.6).
   *
   * Derived on every read rather than stored. A stored card is a second source of truth
   * that goes stale the moment a version is published — and a stale capability descriptor
   * is worse than none, because callers act on it.
   */
  async cardFor(orgId: string, agentName: string, baseUrl: string): Promise<SignedAgentCard> {
    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'name', 'description', 'expose_as_peer', 'archived_at'])
      .where('org_id', '=', orgId)
      .where('name', '=', agentName)
      .executeTakeFirst();

    if (!agent || agent.archived_at !== null) {
      throw new PlatformError('not_found', `Agent "${agentName}" not found`);
    }
    if (!agent.expose_as_peer) {
      // 404-shaped rather than 403: an unexposed agent should not be distinguishable from
      // a nonexistent one by an unauthenticated caller probing the card endpoint.
      throw new PlatformError('not_found', `Agent "${agentName}" not found`);
    }

    const version = await this.db
      .selectFrom('agent_versions')
      .select(['version', 'spec'])
      .where('agent_id', '=', agent.id)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();

    const spec = (version?.spec ?? {}) as { skills?: string[] };
    const skills = await this.skillDescriptors(agent.id, spec.skills ?? []);

    const card: AgentCard = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: agent.name,
      description: agent.description,
      url: `${baseUrl.replace(/\/$/, '')}/a2a/v1`,
      provider: { organization: process.env['A2A_PROVIDER_NAME'] ?? 'general-agent-platform' },
      version: String(version?.version ?? 1),
      capabilities: { ...A2A_CAPABILITIES },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills,
    };
    return signCard(card, this.signingKey());
  }

  /**
   * What the agent advertises it can do, from its declared skills.
   *
   * Skills are the right source: they are already named, described and versioned for
   * exactly this purpose, so exposure needs no separate capability vocabulary — which is
   * §13.6's "do not introduce duplicate capability-registration systems".
   *
   * `instructions` is deliberately not included. It is the procedure, not the offer, and
   * a peer is outside the trust domain.
   */
  private async skillDescriptors(agentId: string, _refs: string[]) {
    const rows = await this.db
      .selectFrom('agent_version_skills as avs')
      .innerJoin('skill_versions as sv', 'sv.id', 'avs.skill_version_id')
      .innerJoin('skills as sk', 'sk.id', 'sv.skill_id')
      .innerJoin('agent_versions as av', 'av.id', 'avs.agent_version_id')
      .select(['sk.name', 'sk.description', 'sv.when_to_use'])
      .where('av.agent_id', '=', agentId)
      .orderBy('av.version', 'desc')
      .orderBy('avs.ord')
      .limit(32)
      .execute();

    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)))
      .map((r) => ({ id: r.name, name: r.name, description: r.when_to_use ?? r.description }));
  }

  /** Re-verifies a stored remote card against the key on file (§13.6). */
  async verifyStoredCard(orgId: string, name: string): Promise<{ valid: boolean; reason?: string }> {
    const peer = await this.db
      .selectFrom('peers')
      .select(['id', 'binding', 'agent_card', 'public_key'])
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!peer) throw new PlatformError('not_found', `Peer "${name}" not found`);
    if (peer.binding === 'local') {
      return { valid: true, reason: 'Local peers carry no signature; their card is derived on read.' };
    }
    if (!peer.agent_card || !peer.public_key) {
      return { valid: false, reason: 'No card or no key on file' };
    }

    const result = verifyCard(peer.agent_card as SignedAgentCard, peer.public_key);
    await this.db
      .updateTable('peers')
      // A failed re-verification CLEARS the timestamp rather than leaving the last success
      // standing. "Verified in March" next to a card that no longer verifies is worse than
      // no timestamp at all.
      .set({ card_verified_at: result.valid ? new Date() : null })
      .where('id', '=', peer.id)
      .execute();
    return result;
  }

  /** Reachability and protocol revision, for a caller deciding whether to route here. */
  async health(orgId: string, name: string): Promise<Record<string, unknown>> {
    const peer = await this.db
      .selectFrom('peers')
      .select(['binding', 'endpoint_url', 'protocol_version', 'local_agent_id', 'timeout_ms'])
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!peer) throw new PlatformError('not_found', `Peer "${name}" not found`);

    if (peer.binding === 'local') {
      const agent = await this.db
        .selectFrom('agents')
        .select(['expose_as_peer', 'archived_at'])
        .where('id', '=', peer.local_agent_id!)
        .executeTakeFirst();
      return {
        binding: 'local',
        reachable: Boolean(agent && agent.archived_at === null && agent.expose_as_peer),
        protocolVersion: peer.protocol_version,
        note: 'Local peers dispatch in-process; reachability is agent existence and exposure.',
      };
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(`${peer.endpoint_url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `tasks/get` on an id that cannot exist. A well-behaved peer answers with a
        // JSON-RPC error, which proves the endpoint speaks the protocol -- a plain 200 on
        // a GET would only prove something is listening.
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'health', method: 'tasks/get',
          params: { id: '00000000-0000-0000-0000-000000000000' },
        }),
        signal: AbortSignal.timeout(Math.min(peer.timeout_ms, 10_000)),
      });
      return {
        binding: 'remote',
        reachable: true,
        httpStatus: response.status,
        speaksJsonRpc: response.headers.get('content-type')?.includes('json') ?? false,
        latencyMs: Date.now() - startedAt,
        protocolVersion: peer.protocol_version,
      };
    } catch (e) {
      return {
        binding: 'remote',
        reachable: false,
        error: (e as Error).message,
        latencyMs: Date.now() - startedAt,
        protocolVersion: peer.protocol_version,
      };
    }
  }

  async retire(orgId: string, name: string): Promise<void> {
    // Disabled, not deleted. `peer_tasks` and `memory_records.source_peer_id` reference
    // peers for §15.3 lineage; deleting the row would make historical provenance
    // unreadable, which is the one thing provenance exists to survive.
    await this.db
      .updateTable('peers')
      .set({ status: 'disabled' })
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .execute();
  }
}
