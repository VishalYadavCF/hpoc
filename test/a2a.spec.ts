import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { FilesystemObjectStore } from '../src/adapters/storage/filesystem.object-store.js';
import { LocalPeerTransport } from '../src/domain/peer/local.peer-transport.js';
import { RemotePeerTransport } from '../src/adapters/peer/remote.peer-transport.js';
import { PeerRouter } from '../src/domain/peer/peer.router.js';
import { QueueService } from '../src/domain/queue/queue.service.js';
import { AgentService } from '../src/domain/agent/agent.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { DeploymentService } from '../src/domain/eval/deployment.service.js';
import {
  canonicalise, keyId, signCard, verifyCard,
  A2A_CAPABILITIES, A2A_PROTOCOL_VERSION, type AgentCard,
} from '../src/domain/peer/agent-card.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';
import type { PeerDispatch } from '../src/domain/ports/peer-transport.port.js';

let f: Fixture;
let peers: PeerService;
let router: PeerRouter;
let admission: AdmissionService;
let agentId: string;
let localPeerId: string;
let remotePeerId: string;
let remoteServer: Server;
let remotePort: number;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT = `peer-target-${SUFFIX}`;
const LOCAL_PEER = `local-${SUFFIX}`;
const REMOTE_PEER = `remote-${SUFFIX}`;

/** A minimal, correct A2A peer, so "remote" is a real network hop rather than a mock. */
const remoteTasks = new Map<string, { state: string; text: string }>();

beforeAll(async () => {
  f = await fixture();
  peers = new PeerService(f.db);
  const uow = new UnitOfWork(f.db);
  const skills = new SkillService(f.db, uow, new FilesystemObjectStore());
  admission = new AdmissionService(f.db, skills, peers, new PromptService(f.db, uow), new PolicyService(f.db, uow));
  const versions = new AgentVersionService(f.db);
  router = new PeerRouter(
    new LocalPeerTransport(
      f.db, new QueueService(f.db),
      new AgentService(f.db, uow, admission, versions, new DeploymentService(f.db, uow)),
    ),
    new RemotePeerTransport(),
  );

  // An exposed agent for the local binding to point at.
  const agent = await f.db
    .insertInto('agents')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, name: AGENT, owner: 'platform-tests',
      description: 'Target of A2A conformance tests', expose_as_peer: true,
    })
    .returning('id').executeTakeFirstOrThrow();
  agentId = agent.id;

  await f.db
    .insertInto('agent_versions')
    .values({
      agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
      lifetime: 'registered', version: 1,
      spec: JSON.stringify({ framework: 'echo', a2a: { exposeAsPeer: true } }),
      spec_hash: `a2a-${SUFFIX}`,
      workload_identity_id: f.principalId, model_id: f.modelId,
    })
    .execute();

  remoteServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}') as { id: unknown; method: string; params: Record<string, unknown> };
      const reply = (result: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));

      if (rpc.method === 'message/send') {
        const id = `remote-task-${remoteTasks.size + 1}`;
        const message = rpc.params['message'] as { parts?: { text?: string }[] };
        remoteTasks.set(id, {
          state: 'completed',
          text: (message.parts ?? []).map((p) => p.text ?? '').join(''),
        });
        reply({ id, contextId: `ctx-${id}`, kind: 'task', status: { state: 'submitted' } });
        return;
      }
      if (rpc.method === 'tasks/get') {
        const task = remoteTasks.get(String(rpc.params['id']));
        if (!task) {
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'not found' } }));
          return;
        }
        reply({
          id: rpc.params['id'], contextId: `ctx-${String(rpc.params['id'])}`,
          status: { state: task.state, message: task.text },
          artifacts: [{ text: task.text }],
        });
        return;
      }
      if (rpc.method === 'tasks/cancel') {
        const task = remoteTasks.get(String(rpc.params['id']));
        if (task) task.state = 'canceled';
        reply({ id: rpc.params['id'], status: { state: 'canceled' } });
        return;
      }
      reply({});
    });
  });
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  remotePort = (remoteServer.address() as { port: number }).port;
});

/**
 * Teardown races a LIVE worker, because the dispatches above were real: the local binding
 * enqueued child runs and a worker is executing them. Deleting those rows while the worker
 * updates them deadlocks — it takes run_queue then runs, and a bulk DELETE took them the
 * other way round.
 *
 * So: drain the queue FIRST (the worker stops picking them up), then delete by explicit,
 * sorted ids so both sides acquire row locks in the same order. The retry is not papering
 * over that — it covers the run already in flight when the queue was drained.
 */
afterAll(async () => {
  if (!f) return;
  const versionIds = (
    await f.db.selectFrom('agent_versions').select('id').where('agent_id', '=', agentId).execute()
  ).map((v) => v.id);

  if (versionIds.length > 0) {
    const runIds = (
      await f.db.selectFrom('runs').select('id')
        .where('agent_version_id', 'in', versionIds)
        .orderBy('id').execute()
    ).map((r) => r.id);

    if (runIds.length > 0) {
      await f.db.deleteFrom('run_queue').where('run_id', 'in', runIds).execute();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await f.db.deleteFrom('runs').where('id', 'in', runIds).execute();
          break;
        } catch (e) {
          if (attempt === 4 || !/deadlock/i.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }

  await f.db.deleteFrom('peers').where('org_id', '=', f.orgId)
    .where('name', 'in', [LOCAL_PEER, REMOTE_PEER]).execute();
  // Versions before the agent: agent_versions is ON DELETE RESTRICT, which is the
  // constraint that stops a live agent being deleted out from under its history.
  await f.db.deleteFrom('agent_versions').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('agents').where('id', '=', agentId).execute();
  if (remoteServer) await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  await f.close();
});

const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

const sampleCard = (): AgentCard => ({
  protocolVersion: A2A_PROTOCOL_VERSION,
  name: 'billing-planner',
  description: 'Plans billing corrections',
  url: 'https://peer.example/a2a/v1',
  provider: { organization: 'other-team' },
  version: '3',
  capabilities: { ...A2A_CAPABILITIES },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'plan', name: 'plan', description: 'Draft a correction plan' }],
});

describe('agent card signing (§13.6)', () => {
  it('canonicalises so two runtimes signing the same card produce the same bytes', () => {
    const a = { b: 1, a: { d: 4, c: [3, { f: 6, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 6 }], d: 4 }, b: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('round-trips a signature', () => {
    const { priv, pub } = keypair();
    expect(verifyCard(signCard(sampleCard(), priv), pub)).toEqual({ valid: true });
  });

  it('rejects a card whose contents were altered after signing', () => {
    const { priv, pub } = keypair();
    const signed = signCard(sampleCard(), priv);
    const tampered = { ...signed, url: 'https://attacker.example/a2a/v1' };
    const result = verifyCard(tampered, pub);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/i);
  });

  it('refuses a card signed by a different key rather than silently failing the maths', () => {
    const { priv } = keypair();
    const other = keypair();
    const result = verifyCard(signCard(sampleCard(), priv), other.pub);
    expect(result.valid).toBe(false);
    // Naming the expected key is what makes a rotation debuggable.
    expect(result.reason).toContain(keyId(createPublicKey(other.pub).export({ type: 'spki', format: 'pem' }).toString()));
  });
});

describe('peer registry (§13.6)', () => {
  it('registers a local peer pointing at an exposed agent', async () => {
    const peer = await peers.register({
      orgId: f.orgId, namespaceId: f.namespaceId,
      name: LOCAL_PEER, binding: 'local', localAgentName: AGENT,
    });
    localPeerId = peer.id;
    expect(peer.name).toBe(LOCAL_PEER);
  });

  it('refuses a local peer whose agent is not exposed', async () => {
    const hidden = await f.db
      .insertInto('agents')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId,
        name: `hidden-${SUFFIX}`, owner: 'platform-tests',
      })
      .returning('id').executeTakeFirstOrThrow();

    const error = await peers
      .register({
        orgId: f.orgId, namespaceId: f.namespaceId,
        name: `hidden-peer-${SUFFIX}`, binding: 'local', localAgentName: `hidden-${SUFFIX}`,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toMatch(/exposeAsPeer/);

    await f.db.deleteFrom('agents').where('id', '=', hidden.id).execute();
  });

  it('refuses a remote peer with no key to verify its card against', async () => {
    const error = await peers
      .register({
        orgId: f.orgId, namespaceId: f.namespaceId, name: `nokey-${SUFFIX}`,
        binding: 'remote', endpointUrl: 'https://peer.example/a2a/v1',
        agentCard: signCard(sampleCard(), keypair().priv),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toMatch(/publicKey/);
  });

  it('refuses a plaintext endpoint — the delegation chain travels over it', async () => {
    const { priv, pub } = keypair();
    const error = await peers
      .register({
        orgId: f.orgId, namespaceId: f.namespaceId, name: `plain-${SUFFIX}`,
        binding: 'remote', endpointUrl: 'http://peer.example/a2a/v1',
        agentCard: signCard(sampleCard(), priv), publicKey: pub,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toMatch(/https/);
  });

  it('registers a remote peer only after its card verifies', async () => {
    const { priv, pub } = keypair();
    const peer = await peers.register({
      orgId: f.orgId, namespaceId: f.namespaceId, name: REMOTE_PEER,
      binding: 'remote',
      // The conformance server is loopback http; https is enforced above, so the row is
      // written with the real endpoint afterwards rather than weakening the rule for a test.
      endpointUrl: 'https://127.0.0.1/a2a/v1',
      agentCard: signCard(sampleCard(), priv), publicKey: pub,
    });
    remotePeerId = peer.id;

    await f.db
      .updateTable('peers')
      .set({ endpoint_url: `http://127.0.0.1:${remotePort}/a2a/v1` })
      .where('id', '=', remotePeerId)
      .execute();

    expect(await peers.verifyStoredCard(f.orgId, REMOTE_PEER)).toEqual({ valid: true });
  });

  it('naming a peer is not enough to reach it (§16.2)', async () => {
    const admit = () =>
      admission.admit({
        orgId: f.orgId, namespaceId: f.namespaceId, callerPrincipalId: f.principalId,
        rawSpec: { model: { ref: 'internal/echo' }, a2a: { peers: [LOCAL_PEER] } },
      });

    const error = await admit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toContain(LOCAL_PEER);

    await f.db
      .insertInto('capability_grants')
      .values({
        org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
        resource_kind: 'peer', resource_id: localPeerId, granted_by: f.principalId,
      })
      .execute();

    expect((await admit()).peers.map((p) => p.name)).toEqual([LOCAL_PEER]);
  });
});

/**
 * §13.4's conformance requirement, as a test.
 *
 * "The bindings must be semantically identical — same states, ordering, error taxonomy,
 * cancellation. Run the suite against both. If an agent behaves differently after moving
 * out of the runtime, the fast path is a bug, discovered during a migration at the worst
 * moment." Every assertion below is written once and executed against both transports.
 */
describe('binding conformance (§13.4)', () => {
  // Resolved lazily, INSIDE each test. The describe body runs at collection time, before
  // beforeAll has created the agent or started the server, so capturing the ids eagerly
  // would freeze `undefined` into every case.
  const BINDINGS = [
    {
      label: 'local',
      peer: (): PeerDispatch['peer'] => ({
        id: localPeerId, name: LOCAL_PEER, binding: 'local',
        localAgentId: agentId, endpointUrl: null, timeoutMs: 30_000,
      }),
    },
    {
      label: 'remote',
      peer: (): PeerDispatch['peer'] => ({
        id: remotePeerId, name: REMOTE_PEER, binding: 'remote',
        localAgentId: null, endpointUrl: `http://127.0.0.1:${remotePort}/a2a/v1`, timeoutMs: 30_000,
      }),
    },
  ];

  const dispatchFor = (peer: PeerDispatch['peer'], tx: PeerDispatch['tx']): PeerDispatch => ({
    tx,
    peer,
    caller: {
      runId: callerRunId, stepId: callerStepId,
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      traceId: null, callerPrincipalId: f.principalId,
      onBehalfOfPrincipalId: null, authorizingHumanId: null,
      maxCostMicros: '100000', delegationDepth: 0, delegationChain: [],
    },
    input: 'plan a correction',
  });

  let callerRunId: string;
  let callerStepId: string;

  beforeAll(async () => {
    const thread = await f.db
      .insertInto('threads')
      .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
      .returning('id').executeTakeFirstOrThrow();
    const version = await f.db
      .selectFrom('agent_versions').select('id').where('agent_id', '=', agentId).executeTakeFirstOrThrow();
    const run = await f.db
      .insertInto('runs')
      .values({
        thread_id: thread.id, agent_version_id: version.id, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'api', caller_principal_id: f.principalId,
      })
      .returning('id').executeTakeFirstOrThrow();
    callerRunId = run.id;
    const step = await f.db
      .insertInto('steps')
      .values({
        run_id: run.id, seq: 0, kind: 'peer_call', status: 'running',
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      })
      .returning('id').executeTakeFirstOrThrow();
    callerStepId = step.id;
  });

  for (const { label, peer } of BINDINGS) {
    describe(label, () => {
      it('returns the same task shape on dispatch', async () => {
        const task = await new UnitOfWork(f.db).run((tx) => router.send(dispatchFor(peer(), tx)));
        expect(task.taskId).toBeTypeOf('string');
        expect(task.taskId.length).toBeGreaterThan(0);
        // Both bindings report the SAME initial state. A remote peer that answered
        // 'working' and a local one that answered 'submitted' would make a caller's
        // state machine depend on where the peer happens to run.
        expect(task.state).toBe('submitted');
        expect(task.error).toBeNull();
      });

      it('reports an unknown task through the same error taxonomy', async () => {
        const error = await router
          .get(peer(), '00000000-0000-0000-0000-000000000000')
          .catch((e: unknown) => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/not found|Peer/i);
      });

      it('accepts cancellation idempotently', async () => {
        const task = await new UnitOfWork(f.db).run((tx) => router.send(dispatchFor(peer(), tx)));
        const p = peer();
        await router.cancel(p, task.taskId);
        // Twice. A cancel that threw on an already-cancelled task would make a retried
        // cancellation an error, and §13.5 propagates cancellation through retries.
        await expect(router.cancel(p, task.taskId)).resolves.toBeUndefined();
      });

      it('only ever reports states from the normalised set', async () => {
        const task = await new UnitOfWork(f.db).run((tx) => router.send(dispatchFor(peer(), tx)));
        const observed = await router.get(peer(), task.taskId);
        expect([
          'submitted', 'working', 'input_required', 'completed', 'failed', 'cancelled',
        ]).toContain(observed.state);
      });
    });
  }

  it('gives a local peer its OWN thread — peer memory is isolated (§13.3)', async () => {
    const task = await new UnitOfWork(f.db).run((tx) =>
      router.send(dispatchFor(BINDINGS[0]!.peer(), tx)),
    );
    const child = await f.db
      .selectFrom('runs').select(['thread_id', 'initiator', 'parent_run_id', 'max_cost_micros'])
      .where('id', '=', task.taskId).executeTakeFirstOrThrow();

    // The one line that separates a peer from a sub-agent in this codebase.
    expect(child.thread_id).not.toBe(
      (await f.db.selectFrom('runs').select('thread_id').where('id', '=', callerRunId).executeTakeFirstOrThrow()).thread_id,
    );
    expect(child.initiator).toBe('peer');
    // §15.3: lineage still crosses the boundary even though trust does not.
    expect(child.parent_run_id).toBe(callerRunId);
    // §13.5 budget propagation: the callee spends the ORIGINATING tenant's ceiling.
    expect(child.max_cost_micros).toBe('100000');
  });
});
