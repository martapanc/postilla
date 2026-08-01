import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The single source of truth for the database shape. `tools/migrate-leancloud`
 * imports these same definitions, so the migrator cannot drift from the server.
 *
 * Every timestamp is `timestamptz`. The legacy Waline schema used
 * `timestamp without time zone`, which is precisely where LeanCloud imports
 * historically corrupted data.
 */

export const commentStatus = pgEnum('comment_status', ['pending', 'approved', 'spam', 'deleted']);
export const userRole = pgEnum('user_role', ['admin', 'moderator']);
export const passwordAlgo = pgEnum('password_algo', ['argon2id', 'phpass']);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * A page that can be commented on. Replaces the `url` string denormalized onto
 * every comment and counter row in the old schema.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Normalized: leading slash, no trailing slash, no query or hash. */
    path: text('path').notNull().unique(),
    title: text('title'),
    pageviews: bigint('pageviews', { mode: 'number' }).notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [index('pages_path_idx').on(t.path)],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** LeanCloud objectId. Null for accounts created after the migration. */
  legacyObjectId: text('legacy_object_id').unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull().default('moderator'),
  passwordHash: text('password_hash').notNull(),
  /** Migrated accounts start as 'phpass' and are rehashed on first login. */
  passwordAlgo: passwordAlgo('password_algo').notNull(),
  /** Base32 TOTP secret, encrypted at rest. */
  totpSecret: text('totp_secret'),
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  avatarUrl: text('avatar_url'),
  websiteUrl: text('website_url'),
  label: text('label'),
  /** Language this user receives notifications in. */
  locale: text('locale').notNull().default('en'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt,
  updatedAt,
});

/**
 * There is deliberately no `user_identities` table. Waline supported six
 * social providers, but the migrated data has zero linked accounts, and
 * authentication is password + TOTP. See docs/adr/0003.
 */

/** Replaces the old `type = 'verify:CODE:EXPIRY'` string overloading. */
export const userVerifications = pgTable(
  'user_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [index('user_verifications_user_id_idx').on(t.userId)],
);

/** Revocable sessions, replacing an unrevocable long-lived JWT in localStorage. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    /** Groups rotated tokens so reuse-detection can revoke the whole family. */
    familyId: uuid('family_id').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_family_id_idx').on(t.familyId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legacyObjectId: text('legacy_object_id').unique(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** The truth about threading. */
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    /** Materialized once at insert, never mutated; equals `id` for top-level. */
    rootId: uuid('root_id')
      .notNull()
      .references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    status: commentStatus('status').notNull().default('pending'),
    /** Source of truth. `bodyHtml` is a regenerable cache of this. */
    bodyMarkdown: text('body_markdown').notNull(),
    bodyHtml: text('body_html').notNull(),
    /**
     * True for comments migrated from LeanCloud, where only rendered HTML was
     * stored and the markdown had to be derived. Marks re-rendering old
     * comments as a deliberate, reversible choice rather than a silent one.
     */
    legacyMarkdownDerived: boolean('legacy_markdown_derived').notNull().default(false),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email'),
    /** sha256(lower(trim(email))). Drives avatars and the auditFirstOnly policy. */
    authorEmailHash: text('author_email_hash'),
    authorUrl: text('author_url'),
    authorIp: text('author_ip'),
    userAgent: text('user_agent'),
    isSticky: boolean('is_sticky').notNull().default(false),
    likeCount: integer('like_count').notNull().default(0),
    locale: text('locale'),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('comments_page_status_created_idx').on(t.pageId, t.status, t.createdAt.desc()),
    index('comments_root_created_idx').on(t.rootId, t.createdAt),
    index('comments_author_email_hash_idx')
      .on(t.authorEmailHash)
      .where(sql`${t.authorEmailHash} is not null`),
    index('comments_pending_idx')
      .on(t.status, t.createdAt.desc())
      .where(sql`${t.status} = 'pending'`),
    check('comments_no_self_parent', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

/**
 * Registry of available reactions, replacing the positional `reaction0..8`
 * columns. Adding or renaming a reaction is now data, not a schema change.
 */
export const reactionKinds = pgTable('reaction_kinds', {
  key: text('key').primaryKey(),
  emoji: text('emoji').notNull(),
  sortOrder: integer('sort_order').notNull(),
  /** 0..8, used only to map the legacy columns during migration. */
  legacyIndex: smallint('legacy_index').unique(),
});

export const reactions = pgTable(
  'reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    kindKey: text('kind_key')
      .notNull()
      .references(() => reactionKinds.key),
    /**
     * hmac(ip + user agent, daily-rotating salt). Gives server-side idempotency
     * and toggling; the old client only deduplicated in localStorage, so the
     * same visitor could inflate a count from another browser.
     */
    visitorHash: text('visitor_hash').notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex('reactions_page_kind_visitor_key').on(t.pageId, t.kindKey, t.visitorHash),
    index('reactions_page_kind_idx').on(t.pageId, t.kindKey),
  ],
);

/**
 * Migrated reaction totals, which arrive as counts with no individual events.
 * A page's displayed count is `baseline + count(reactions)`.
 */
export const reactionBaselines = pgTable(
  'reaction_baselines',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    kindKey: text('kind_key')
      .notNull()
      .references(() => reactionKinds.key),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.kindKey] })],
);

/**
 * Transactional outbox. A comment and its notification are written in one
 * transaction, so a failing webhook can never fail the comment, and a
 * successful comment can never silently drop its notification.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    /**
     * Coalescing key, e.g. `reaction:{pageId}:{kind}:{15-minute bucket}`.
     * The partial unique index below collapses a burst of reactions into one
     * message carrying the final counts.
     */
    dedupeKey: text('dedupe_key'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt,
  },
  (t) => [
    uniqueIndex('notification_outbox_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`${t.deliveredAt} is null`),
    index('notification_outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.deliveredAt} is null`),
  ],
);

export const moderationLog = pgTable(
  'moderation_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id),
    fromStatus: commentStatus('from_status'),
    toStatus: commentStatus('to_status').notNull(),
    reason: text('reason'),
    createdAt,
  },
  (t) => [index('moderation_log_comment_id_idx').on(t.commentId)],
);

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
export type OutboxMessage = typeof notificationOutbox.$inferSelect;
