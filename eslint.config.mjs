// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Architectural boundaries are enforced here rather than by convention.
 * The old Waline server was untestable because ThinkJS's ambient `think.*`
 * global and its service locator let any layer reach any other. These rules
 * are what stop that from happening again — treat a violation as a design
 * error, not a lint nit to silence.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Standalone config files that sit outside any tsconfig `include`.
          // No '**' permitted here: typescript-eslint rejects globs wide
          // enough to drag the whole tree into the default project.
          allowDefaultProject: ['*.config.ts', '*.config.mjs', 'apps/*/*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ── Boundary: only config/env.ts may read process.env ──────────────────────
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'tools/**/*.ts'],
    ignores: [
      'apps/server/src/config/env.ts',
      // Standalone CLIs that run before (or instead of) the app, so there is
      // no validated config object for them to read from.
      'apps/server/src/infrastructure/db/migrate.ts',
      'tools/**/src/cli.ts',
      'apps/server/src/infrastructure/db/backfill-html.ts',
      // The integration-test harness connects to whatever database the
      // developer or CI provides; there is no app config at that point.
      'apps/server/src/test-support/**',
      '**/*.config.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from the validated config object instead. Env parsing lives in apps/server/src/config/env.ts and happens once, at boot.',
        },
      ],
    },
  },

  // ── Boundary: the domain is pure ───────────────────────────────────────────
  {
    files: ['apps/server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fastify',
                'fastify/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'pino',
                '**/infrastructure/**',
                '**/transport/**',
                '**/application/**',
              ],
              message:
                'The domain layer must stay pure: no IO, no framework, no persistence. Depend on a port interface instead, and let the composition root supply the adapter.',
            },
          ],
        },
      ],
    },
  },

  // ── Boundary: only the transport layer knows about Fastify ─────────────────
  // `no-restricted-imports` is not additive across flat-config blocks — the
  // last matching block wins outright. The domain and ports directories are
  // excluded here because they declare their own, stricter version below;
  // without these ignores this block would silently replace theirs.
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: [
      'apps/server/src/transport/**',
      'apps/server/src/main.ts',
      'apps/server/src/app.ts',
      'apps/server/src/domain/**',
      'apps/server/src/ports/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'fastify/*', '@fastify/*'],
              message:
                'Fastify belongs to the transport layer only. Keeping it there is what makes a future Hono port a contained change.',
            },
          ],
        },
      ],
    },
  },

  // ── Boundary: ports declare interfaces, they do not implement them ─────────
  {
    files: ['apps/server/src/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/infrastructure/**',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'fastify',
                'fastify/*',
                '@fastify/*',
              ],
              message: 'Ports are interfaces. Implementations live in infrastructure/.',
            },
          ],
        },
      ],
    },
  },

  // Command-line entry points report to stdout by design; that is their
  // interface, not stray debugging.
  {
    files: [
      'tools/**/src/cli.ts',
      'apps/server/src/infrastructure/db/backfill-html.ts',
      'apps/server/src/infrastructure/db/migrate.ts',
    ],
    rules: { 'no-console': 'off' },
  },

  // Fastify's plugin contract is an async function; an `await`-free one is
  // idiomatic there, not an oversight.
  {
    files: ['apps/server/src/transport/routes/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/vitest.config.ts', '**/*.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
