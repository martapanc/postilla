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

/**
 * Env vars are strings. Accepts the spellings people actually write, and
 * rejects anything else rather than silently treating it as false — a typo in
 * `COMMENT_AUDIT` should not quietly publish every comment.
 */
const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));

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

    // ── Moderation ──────────────────────────────────────────────────────────
    /** Hold every comment for review. */
    COMMENT_AUDIT: boolish.default(false),
    /** Hold only a commenter's first comment; auto-approve them thereafter. */
    COMMENT_AUDIT_FIRST_ONLY: boolish.default(false),
    /** Case-insensitive substrings that mark a comment as spam outright. */
    FORBIDDEN_WORDS: csv.default([]),

    // ── Submission limits ───────────────────────────────────────────────────
    COMMENT_MIN_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(15),
    COMMENT_MAX_PER_WINDOW: z.coerce.number().int().positive().default(10),
    COMMENT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
    COMMENT_MAX_LENGTH: z.coerce.number().int().positive().default(5000),
    COMMENT_MAX_NAME_LENGTH: z.coerce.number().int().positive().default(60),

    // ── Third parties. Absent means the feature is off. ─────────────────────
    AKISMET_KEY: z.string().min(1).optional(),
    TURNSTILE_SECRET: z.string().min(1).optional(),

    // ── Notifications. A channel with no credentials is simply not built. ───
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_CHAT_ID: z.string().min(1).optional(),
    DISCORD_WEBHOOK: z.url().optional(),
    WEBHOOK_URL: z.url().optional(),

    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: boolish.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(1).optional(),
    /** Where comment notifications are sent. Usually the site owner. */
    NOTIFY_EMAIL_TO: z.email().optional(),

    /** Reactions inside this window collapse into one notification. */
    REACTION_COALESCE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    /** Set false to run the API without a notification worker in-process. */
    OUTBOX_WORKER_ENABLED: boolish.default(true),
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
  readonly moderation: {
    auditAll: boolean;
    auditFirstOnly: boolean;
    forbiddenWords: string[];
  };
  readonly limits: {
    minIntervalSeconds: number;
    maxPerWindow: number;
    windowSeconds: number;
    maxBodyLength: number;
    maxNameLength: number;
  };
  readonly akismet: { apiKey: string } | null;
  readonly turnstile: { secretKey: string } | null;
  readonly notifications: {
    telegram: { botToken: string; chatId: string } | null;
    discord: { webhookUrl: string } | null;
    webhook: { url: string } | null;
    email: {
      host: string;
      port: number;
      secure: boolean;
      user: string | undefined;
      password: string | undefined;
      from: string;
      to: string;
    } | null;
    coalesceWindowSeconds: number;
    pollIntervalMs: number;
    workerEnabled: boolean;
  };
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
    moderation: {
      auditAll: env.COMMENT_AUDIT,
      auditFirstOnly: env.COMMENT_AUDIT_FIRST_ONLY,
      forbiddenWords: env.FORBIDDEN_WORDS,
    },
    limits: {
      minIntervalSeconds: env.COMMENT_MIN_INTERVAL_SECONDS,
      maxPerWindow: env.COMMENT_MAX_PER_WINDOW,
      windowSeconds: env.COMMENT_WINDOW_SECONDS,
      maxBodyLength: env.COMMENT_MAX_LENGTH,
      maxNameLength: env.COMMENT_MAX_NAME_LENGTH,
    },
    // Presence of a key is what enables the integration, so "is Akismet on?"
    // is answered once at boot rather than at every call site.
    akismet: env.AKISMET_KEY ? { apiKey: env.AKISMET_KEY } : null,
    turnstile: env.TURNSTILE_SECRET ? { secretKey: env.TURNSTILE_SECRET } : null,
    notifications: {
      // Telegram needs both halves to be useful; a token without a chat id is
      // a misconfiguration, not a half-enabled channel.
      telegram:
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
          : null,
      discord: env.DISCORD_WEBHOOK ? { webhookUrl: env.DISCORD_WEBHOOK } : null,
      webhook: env.WEBHOOK_URL ? { url: env.WEBHOOK_URL } : null,
      email:
        env.SMTP_HOST && env.SMTP_FROM && env.NOTIFY_EMAIL_TO
          ? {
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              user: env.SMTP_USER,
              password: env.SMTP_PASSWORD,
              from: env.SMTP_FROM,
              to: env.NOTIFY_EMAIL_TO,
            }
          : null,
      coalesceWindowSeconds: env.REACTION_COALESCE_WINDOW_SECONDS,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      workerEnabled: env.OUTBOX_WORKER_ENABLED,
    },
  };
}
