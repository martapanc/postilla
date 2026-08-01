import { defineConfig } from 'vitest/config';

/**
 * Two projects, because they have very different costs. `unit` is pure and
 * runs in milliseconds on every save; `integration` needs a real Postgres and
 * runs in CI and on demand. Keeping them separate is what stops the fast
 * suite from rotting into the slow one.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'apps/**/src/**/*.test.ts',
            'packages/**/src/**/*.test.ts',
            'tools/**/src/**/*.test.ts',
          ],
          // Specifying `exclude` replaces Vitest's defaults, so node_modules
          // has to be named explicitly or dependency test suites get collected.
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/**/*.integration.test.ts', 'tools/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          // Every file shares one database and truncates between tests, so
          // running them concurrently means they delete each other's fixtures.
          // Sequential is the honest fix; per-worker schemas would buy speed
          // this suite does not yet need.
          fileParallelism: false,
          // Containers and migrations make these far slower than unit tests.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/*.config.ts'],
      thresholds: {
        // The domain is where the rules live, so it carries the strict gate.
        'apps/server/src/domain/**': { lines: 90, functions: 90, branches: 85 },
        lines: 70,
        functions: 70,
      },
    },
  },
});
