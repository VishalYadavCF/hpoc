import { afterEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { match } from 'path-to-regexp';
import { ApiModule } from '../src/api/api.module.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { SchedulerModule } from '../src/scheduler/scheduler.module.js';
import { RunLoop } from '../src/domain/run-engine/run-loop.service.js';
import { ModelGateway } from '../src/domain/model-gateway/model-gateway.service.js';
import { ToolRuntime } from '../src/domain/tool-runtime/tool-runtime.service.js';

/**
 * Every process root resolves its whole provider graph.
 *
 * A provider a module forgot to export compiles fine and fails only when the process boots,
 * so splitting modules is exactly the change that type-checking cannot guard. `compile()`
 * resolves and constructs every provider; `init()` is deliberately NOT called, because it
 * would start the worker claiming runs and the scheduler contending for leadership.
 */
let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
});

describe('process module graphs', () => {
  it.each([
    ['api', ApiModule],
    ['worker', WorkerModule],
    ['scheduler', SchedulerModule],
  ])('%s root resolves every provider', async (_role, root) => {
    moduleRef = await Test.createTestingModule({ imports: [root] }).compile();
    expect(moduleRef).toBeDefined();
  });

  // The execution engine reaches models, tools and credentials. Only the process that drives
  // runs should construct it: an api or scheduler holding a ModelGateway is one import away
  // from calling a provider outside a run, with no step, lease or budget around the call.
  it.each([
    ['api', ApiModule, false],
    ['worker', WorkerModule, true],
    ['scheduler', SchedulerModule, false],
  ])('%s root holds the execution engine only if it drives runs', async (_role, root, expected) => {
    moduleRef = await Test.createTestingModule({ imports: [root] }).compile();
    for (const engine of [RunLoop, ModelGateway, ToolRuntime]) {
      const held = (() => {
        try {
          moduleRef!.get(engine, { strict: false });
          return true;
        } catch {
          return false;
        }
      })();
      expect(held, engine.name).toBe(expected);
    }
  });

  // Express answers with the FIRST registered route that matches, and controllers now
  // register module by module. A route shadowed by an earlier, wider one (`/v1/memory/:id`
  // swallowing `/v1/memory/sharing`) still appears in the router and in the OpenAPI
  // document -- it just never runs. So: every route must be the first match for its own path.
  it('no route is shadowed by one registered before it', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ logger: false });
    await app.init();
    type Layer = { route?: { path: string; methods: Record<string, boolean> } };
    const stack = (app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } }).router.stack;
    const routes = stack.flatMap((l) =>
      l.route ? Object.keys(l.route.methods).map((m) => ({ method: m, path: l.route!.path })) : []);
    expect(routes.length).toBeGreaterThan(100);

    const shadowed = routes.flatMap((r) => {
      const sample = r.path.replace(/[:*](\w+)/g, 'sample-$1');
      const first = routes.find((c) => c.method === r.method && match(c.path)(sample));
      return first === r ? [] : [`${r.method.toUpperCase()} ${r.path} is answered by ${first?.path}`];
    });
    expect(shadowed).toEqual([]);
    await app.close();
  });
});
