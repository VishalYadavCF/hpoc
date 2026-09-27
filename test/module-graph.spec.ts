import { afterEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ApiModule } from '../src/api/api.module.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { SchedulerModule } from '../src/scheduler/scheduler.module.js';

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
});
