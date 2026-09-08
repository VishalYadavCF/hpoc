import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Integration tests share one Postgres schema; running files in parallel makes
    // their fixtures race. Unit tests are unaffected by the serialisation.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
    setupFiles: ['test/setup.ts'],
    // Integration tests wait on a worker to claim, execute and settle a run. The 5s
    // default fails them for being realistic rather than for being wrong.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
