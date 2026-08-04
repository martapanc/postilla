import type { Pool } from 'pg';
import { createDatabase, type Database } from './infrastructure/db/client.js';
import { createCommentRepository } from './infrastructure/db/repositories/comment-repository.js';
import { createPageRepository } from './infrastructure/db/repositories/page-repository.js';
import { createListComments } from './application/use-cases/list-comments.js';
import { createGetPageStats, createRecordPageview } from './application/use-cases/page-stats.js';
import { createCreateComment } from './application/use-cases/create-comment.js';
import { createRecordReaction } from './application/use-cases/record-reaction.js';
import { createReactionRepository } from './infrastructure/db/repositories/reaction-repository.js';
import {
  createDiscordChannel,
  createTelegramChannel,
  createWebhookChannel,
  type NotificationChannel,
} from './infrastructure/notifications/channels.js';
import { createEmailChannel } from './infrastructure/notifications/email-channel.js';
import {
  createOutboxWorker,
  type OutboxWorker,
} from './infrastructure/notifications/outbox-worker.js';
import { createMarkdownRenderer } from './infrastructure/markdown/renderer.js';
import { createAkismetChecker, noopSpamChecker } from './infrastructure/spam/akismet.js';
import {
  createTurnstileVerifier,
  noopCaptchaVerifier,
} from './infrastructure/captcha/turnstile.js';
import { systemClock } from './ports/services.js';
import type {
  CommentRepository,
  PageRepository,
  ReactionRepository,
} from './ports/repositories.js';
import type { CaptchaVerifier, Clock, MarkdownRenderer, SpamChecker } from './ports/services.js';
import type { AppConfig } from './config/env.js';

/**
 * The composition root: the one place that knows which concrete adapter
 * satisfies which port. Everything else receives its collaborators as
 * arguments, which is what makes the layers testable in isolation.
 *
 * There is deliberately no global registry and no service locator.
 */
export interface Container {
  readonly config: AppConfig;
  readonly db: Database;
  readonly repositories: {
    readonly comments: CommentRepository;
    readonly pages: PageRepository;
    readonly reactions: ReactionRepository;
  };
  readonly channels: readonly NotificationChannel[];
  readonly outboxWorker: OutboxWorker;
  readonly services: {
    readonly renderer: MarkdownRenderer;
    readonly spamChecker: SpamChecker;
    readonly captcha: CaptchaVerifier;
    readonly clock: Clock;
  };
  readonly useCases: {
    readonly listComments: ReturnType<typeof createListComments>;
    readonly getPageStats: ReturnType<typeof createGetPageStats>;
    readonly recordPageview: ReturnType<typeof createRecordPageview>;
    readonly createComment: ReturnType<typeof createCreateComment>;
    readonly recordReaction: ReturnType<typeof createRecordReaction>;
  };
  readonly shutdown: () => Promise<void>;
}

/** Everything above the database, wired by hand. */
export function createContainerFrom(
  config: AppConfig,
  db: Database,
  shutdown: () => Promise<void>,
  /** Overridden in tests to avoid real network calls. */
  overrides: Partial<Container['services']> = {},
): Container {
  const repositories = {
    comments: createCommentRepository(db),
    pages: createPageRepository(db),
    reactions: createReactionRepository(db),
  };

  // A channel with no credentials is simply not in the list, so "is Telegram
  // configured?" is a startup fact rather than a check at every send.
  const n = config.notifications;
  const channels: NotificationChannel[] = [
    n.telegram ? createTelegramChannel(n.telegram) : null,
    n.discord ? createDiscordChannel(n.discord) : null,
    n.email ? createEmailChannel(n.email) : null,
    n.webhook ? createWebhookChannel(n.webhook) : null,
  ].filter((channel) => channel !== null);

  const outboxWorker = createOutboxWorker({
    db,
    channels,
    context: {
      siteName: config.site.name,
      siteUrl: config.site.url ?? config.site.serverUrl,
      adminUrl: `${config.site.serverUrl}/admin`,
    },
    locale: config.locale.default,
    pollIntervalMs: n.pollIntervalMs,
  });

  // An unconfigured integration is absent from the graph entirely, rather than
  // being checked for at every call site. "Is Akismet on?" is answered here,
  // once, at boot.
  const services: Container['services'] = {
    renderer: overrides.renderer ?? createMarkdownRenderer(),
    spamChecker:
      overrides.spamChecker ??
      (config.akismet
        ? createAkismetChecker({
            apiKey: config.akismet.apiKey,
            blogUrl: config.site.url ?? config.site.serverUrl,
          })
        : noopSpamChecker),
    captcha:
      overrides.captcha ??
      (config.turnstile
        ? createTurnstileVerifier({ secretKey: config.turnstile.secretKey })
        : noopCaptchaVerifier),
    clock: overrides.clock ?? systemClock,
  };

  return {
    config,
    db,
    repositories,
    channels,
    outboxWorker,
    services,
    useCases: {
      listComments: createListComments(repositories.comments),
      getPageStats: createGetPageStats(repositories.pages),
      recordPageview: createRecordPageview(repositories.pages),
      createComment: createCreateComment({
        repo: repositories.comments,
        renderer: services.renderer,
        spamChecker: services.spamChecker,
        captcha: services.captcha,
        clock: services.clock,
        moderation: config.moderation,
        limits: config.limits,
        siteUrl: config.site.url ?? config.site.serverUrl,
      }),
      recordReaction: createRecordReaction({
        repo: repositories.reactions,
        clock: services.clock,
        secretKey: config.secretKey,
        coalesceWindowSeconds: n.coalesceWindowSeconds,
      }),
    },
    shutdown,
  };
}

export function createContainer(config: AppConfig): Container {
  const { db, pool }: { db: Database; pool: Pool } = createDatabase(config);
  return createContainerFrom(config, db, async () => {
    await pool.end();
  });
}
