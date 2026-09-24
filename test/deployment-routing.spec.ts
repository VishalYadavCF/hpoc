import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { DeploymentService } from '../src/domain/eval/deployment.service.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { AgentService } from '../src/domain/agent/agent.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { FilesystemObjectStore } from '../src/adapters/storage/filesystem.object-store.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { RunService } from '../src/domain/run-engine/run.service.js';
import { EventLog } from '../src/domain/event-log/event-log.service.js';
import { QueueService } from '../src/domain/queue/queue.service.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let deployments: DeploymentService;
let agents: AgentService;
let runs: RunService;
let agentId: string;
let v1Id: string;
let v2Id: string;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT = `routing-target-${SUFFIX}`;

const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
      authorizingHumanId: null, delegationChain: [],
      traceId: `routing-${SUFFIX}`, correlationId: `routing-${SUFFIX}`,
    },
    fn,
  );

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  const skills = new SkillService(f.db, uow, new FilesystemObjectStore());
  const prompts = new PromptService(f.db, uow);
  const peers = new PeerService(f.db);
  const admission = new AdmissionService(f.db, skills, peers, prompts, new PolicyService(f.db, uow));
  const versions = new AgentVersionService(f.db);
  deployments = new DeploymentService(f.db, uow);
  agents = new AgentService(f.db, uow, admission, versions, deployments);
  runs = new RunService(f.db, uow, admission, versions, new EventLog(), new QueueService(f.db));

  const agent = await f.db
    .insertInto('agents')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, name: AGENT, owner: 'routing-tests' })
    .returning('id').executeTakeFirstOrThrow();
  agentId = agent.id;

  const mkVersion = (version: number, hash: string) =>
    f.db.insertInto('agent_versions').values({
      agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
      lifetime: 'registered', version,
      spec: JSON.stringify({ framework: 'echo' }), spec_hash: hash,
      workload_identity_id: f.principalId, model_id: f.modelId,
    }).returning('id').executeTakeFirstOrThrow();

  v1Id = (await mkVersion(1, `routing-v1-${SUFFIX}`)).id;
  v2Id = (await mkVersion(2, `routing-v2-${SUFFIX}`)).id;
});

/**
 * These runs are real: a live worker process may pick them up and race this cleanup for
 * the same rows, which Postgres resolves as a deadlock on one side rather than a
 * constraint violation. A deadlock aborts the losing transaction outright, so retrying
 * the same statement is the correct response, not a sign the statement is wrong.
 */
async function withDeadlockRetry(fn: () => Promise<unknown>, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (i === attempts - 1 || !/deadlock detected/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

afterAll(async () => {
  // Shadow rows first: `shadow_of_run_id` points at the primary run, so deleting the
  // primary first would either violate the FK or (since it's ON DELETE SET NULL) just
  // orphan the shadow row instead of removing it.
  await withDeadlockRetry(() =>
    f.db.deleteFrom('runs').where('namespace_id', '=', f.namespaceId)
      .where('shadow_of_run_id', 'is not', null)
      .where('agent_version_id', 'in', [v1Id, v2Id]).execute(),
  );
  await withDeadlockRetry(() =>
    f.db.deleteFrom('runs').where('namespace_id', '=', f.namespaceId)
      .where('agent_version_id', 'in', [v1Id, v2Id]).execute(),
  );
  await f.db.deleteFrom('deployments').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('agent_versions').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('agents').where('id', '=', agentId).execute();
  await f.close();
});

describe('deployment traffic routing (§15.5)', () => {
  it('a partial canary keeps the active row live instead of retiring it', async () => {
    await ctx(() => deployments.promote({ agentName: AGENT, environment: 'production', agentVersionId: v1Id }));
    await ctx(() => deployments.promote({
      agentName: AGENT, environment: 'production', agentVersionId: v2Id, canaryPercent: 30,
      shadowFromCurrent: true,
    }));

    const live = await f.db
      .selectFrom('deployments')
      .select(['agent_version_id', 'state', 'shadow_from_version_id'])
      .where('agent_id', '=', agentId).where('environment', '=', 'production')
      .where('state', 'in', ['active', 'rolling'])
      .execute();

    expect(live).toHaveLength(2);
    const active = live.find((d) => d.state === 'active')!;
    const rolling = live.find((d) => d.state === 'rolling')!;
    expect(active.agent_version_id).toBe(v1Id);
    expect(rolling.agent_version_id).toBe(v2Id);
    // Shadowed against the STABLE version, not against nothing.
    expect(rolling.shadow_from_version_id).toBe(v1Id);
  });

  it('resolveTraffic splits deterministically at the 0% and 100% edges', async () => {
    // Force the edges directly: promote() itself refuses canaryPercent >= 100 as a
    // partial canary, so this isolates resolveTraffic's own split logic from promote()'s.
    await f.db.updateTable('deployments').set({ canary_percent: 0 })
      .where('agent_id', '=', agentId).where('state', '=', 'rolling').execute();
    for (let i = 0; i < 20; i++) {
      const routed = await deployments.resolveTraffic(agentId, 'production');
      expect(routed?.versionId).toBe(v1Id);
    }

    await f.db.updateTable('deployments').set({ canary_percent: 100 })
      .where('agent_id', '=', agentId).where('state', '=', 'rolling').execute();
    for (let i = 0; i < 20; i++) {
      const routed = await deployments.resolveTraffic(agentId, 'production');
      expect(routed?.versionId).toBe(v2Id);
    }
  });

  it('AgentService.currentVersionId routes through the deployment, not "latest"', async () => {
    // v2 (version 2) is the higher version number, but staging has never been deployed
    // to, so it must fall back to latest-published rather than reporting "no version".
    const staging = await agents.currentVersionId(agentId, 'staging');
    expect(staging.versionId).toBe(v2Id);
    expect(staging.shadowFromVersionId).toBeNull();

    // production has both an active and a rolling deployment; canary_percent is still 100
    // from the previous test, so it deterministically routes to the rolling version.
    const production = await agents.currentVersionId(agentId, 'production');
    expect(production.versionId).toBe(v2Id);
  });

  it('createFromVersionWithShadow fires a linked shadow run', async () => {
    await ctx(async () => {
      const primary = await runs.createFromVersionWithShadow({
        agentVersionId: v2Id, shadowFromVersionId: v1Id,
        input: { hello: 'world' }, initiator: 'api',
      });
      expect(primary.reused).toBe(false);

      const shadow = await f.db
        .selectFrom('runs')
        .select(['id', 'agent_version_id', 'initiator', 'thread_id'])
        .where('shadow_of_run_id', '=', primary.runId)
        .executeTakeFirst();
      expect(shadow).toBeDefined();
      expect(shadow!.agent_version_id).toBe(v1Id);
      expect(shadow!.initiator).toBe('shadow');
      // Its own thread: a shadow run must not land in the caller's conversation history.
      expect(shadow!.thread_id).not.toBe(primary.threadId);
    });
  });

  it('does not fire a shadow when none was resolved', async () => {
    await ctx(async () => {
      const primary = await runs.createFromVersionWithShadow({
        agentVersionId: v1Id, shadowFromVersionId: null,
        input: { hello: 'no-shadow' }, initiator: 'api',
      });
      const shadow = await f.db
        .selectFrom('runs').select('id')
        .where('shadow_of_run_id', '=', primary.runId)
        .executeTakeFirst();
      expect(shadow).toBeUndefined();
    });
  });
});
