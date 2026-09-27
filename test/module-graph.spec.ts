import { afterEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
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
});
