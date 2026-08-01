import { z } from 'zod';

/**
 * The only place in the codebase permitted to read process.env — enforced by
 * a lint rule, not by discipline. Parsed once, at boot, so a misconfigured
 * deployment fails immediately and legibly instead of at the first request
 * that happens to touch the missing variable.
 */

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8360),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    /** Public origin of this server, used to build permalinks in notifications. */
    SERVER_URL: z.url(),
    /** Origins allowed to embed the widget. Empty means same-origin only. */
    ALLOWED_ORIGINS: csv.default([]),

    /**
     * Display name of the site, used in notification subjects and bodies.
     * `WALINE_SITE_NAME` is accepted as a deprecated alias: the fork was forced
     * to rename it because Vercel reserves SITE_NAME. Leaving Vercel removes
     * that constraint, but a live deployment still sets the old name.
     */
    SITE_NAME: z.string().min(1).optional(),
    WALINE_SITE_NAME: z.string().min(1).optional(),
    SITE_URL: z.url().optional(),

    DEFAULT_LOCALE: z.enum(['en', 'it']).default('en'),

    SECRET_KEY: z.string().min(32, 'SECRET_KEY must be at least 32 characters'),
  })
  .transform((env, ctx) => {
    const siteName = env.SITE_NAME ?? env.WALINE_SITE_NAME;
    if (!siteName) {
      ctx.addIssue({
        code: 'custom',
        path: ['SITE_NAME'],
        message: 'SITE_NAME is required (WALINE_SITE_NAME is accepted as a deprecated alias)',
      });
      return z.NEVER;
    }
    return { ...env, SITE_NAME: siteName };
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly http: { host: string; port: number; allowedOrigins: string[] };
  readonly log: { level: Env['LOG_LEVEL'] };
  readonly db: { url: string; poolMax: number };
  readonly site: { name: string; url: string | undefined; serverUrl: string };
  readonly locale: { default: Env['DEFAULT_LOCALE'] };
  readonly secretKey: string;
}

/**
 * Parses and validates the environment. Throws an aggregated, readable error
 * listing every problem at once rather than failing on the first.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const env = result.data;

  if (source['WALINE_SITE_NAME'] && !source['SITE_NAME']) {
    console.warn(
      '[config] WALINE_SITE_NAME is deprecated; rename it to SITE_NAME. It is honoured for now.',
    );
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    http: { host: env.HOST, port: env.PORT, allowedOrigins: env.ALLOWED_ORIGINS },
    log: { level: env.LOG_LEVEL },
    db: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    site: { name: env.SITE_NAME, url: env.SITE_URL, serverUrl: env.SERVER_URL },
    locale: { default: env.DEFAULT_LOCALE },
    secretKey: env.SECRET_KEY,
  };
}
