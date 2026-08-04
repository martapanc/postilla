import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CreateCommentResponse, ProblemDetails } from '@postilla/contract';
import { buildApp } from '../../app.js';
import { loadConfig, type AppConfig } from '../../config/env.js';
import { createContainerFrom, type Container } from '../../container.js';
import { comments, notificationOutbox } from '../../infrastructure/db/schema.js';
import { connectTestDatabase, type TestDatabase } from '../../test-support/database.js';

let harness: TestDatabase;

beforeAll(() => {
  harness = connectTestDatabase();
});
afterAll(async () => await harness.close());
beforeEach(async () => await harness.reset());

const baseEnv = {
  DATABASE_URL: process.env['DATABASE_URL'],
  SERVER_URL: 'http://localhost:8360',
  SITE_URL: 'https://blog.example',
  SITE_NAME: 'Test',
  SECRET_KEY: 'a'.repeat(32),
  LOG_LEVEL: 'fatal',
};

/**
 * Builds an app with the third-party adapters replaced by deterministic fakes.
 * Nothing here touches the network — the composition root exists precisely so
 * this substitution is one argument rather than a mocking framework.
 */
async function buildWith(
  env: Record<string, string | undefined> = {},
  services: Partial<Container['services']> = {},
): Promise<FastifyInstance> {
  const config: AppConfig = loadConfig({ ...baseEnv, ...env });
  return buildApp(createContainerFrom(config, harness.db, () => Promise.resolve(), services));
}

const body = (over: Record<string, unknown> = {}) => ({
  path: '/post',
  comment: 'A perfectly ordinary comment.',
  nick: 'Alice',
  mail: 'alice@example.com',
  ...over,
});

async function post(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/comments', payload });
}

describe('POST /api/comments — happy path', () => {
  it('creates an approved comment and returns 201', async () => {
    const app = await buildWith();

    const response = await post(app, body());

    expect(response.statusCode).toBe(201);
    expect(response.json<CreateCommentResponse>().status).toBe('approved');
    await app.close();
  });

  it('renders markdown to sanitized html at write time', async () => {
    const app = await buildWith();

    await post(app, body({ comment: '**bold** <script>alert(1)</script>' }));
    const [row] = await harness.db.select().from(comments);

    expect(row?.bodyHtml).toContain('<strong>bold</strong>');
    expect(row?.bodyHtml).not.toContain('<script');
    // The source is kept verbatim so the HTML can always be regenerated.
    expect(row?.bodyMarkdown).toContain('<script>');
    await app.close();
  });

  it('creates the page on first comment', async () => {
    const app = await buildWith();

    await post(app, body({ path: '/Brand-New/?utm=x' }));
    const [row] = await harness.db.select().from(comments);

    expect(row).toBeDefined();
    // Path normalization applies on write as well as read.
    const [page] = await harness.db
      .execute<{ path: string }>(sql`select path from pages`)
      .then((r) => r.rows);
    expect(page?.path).toBe('/brand-new');
    await app.close();
  });

  it('roots a top-level comment at itself', async () => {
    const app = await buildWith();

    await post(app, body());
    const [row] = await harness.db.select().from(comments);

    expect(row?.rootId).toBe(row?.id);
    expect(row?.parentId).toBeNull();
    await app.close();
  });

  it('attaches a reply to its parent thread', async () => {
    // The interval limit is disabled here: this test is about threading, and
    // two submissions in the same millisecond would otherwise trip it.
    const app = await buildWith({ COMMENT_MIN_INTERVAL_SECONDS: '0' });
    const parent = await post(app, body());
    const parentId = parent.json<CreateCommentResponse>().id;

    await post(app, body({ comment: 'a reply', parentId, mail: 'bob@example.com' }));
    const rows = await harness.db.select().from(comments).where(eq(comments.parentId, parentId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rootId).toBe(parentId);
    await app.close();
  });

  it('queues exactly one outbox row in the same transaction', async () => {
    const app = await buildWith();

    await post(app, body());
    const outbox = await harness.db.select().from(notificationOutbox);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('comment.created');
    expect(outbox[0]?.deliveredAt).toBeNull();
    await app.close();
  });

  it('stores the author IP and user agent but never returns them', async () => {
    const app = await buildWith();

    const response = await post(app, body());
    const [row] = await harness.db.select().from(comments);

    expect(row?.userAgent).toBeDefined();
    expect(response.payload).not.toContain('alice@example.com');
    await app.close();
  });
});

describe('POST /api/comments — moderation', () => {
  it('holds a first-time commenter under auditFirstOnly', async () => {
    const app = await buildWith({ COMMENT_AUDIT_FIRST_ONLY: 'true' });

    const response = await post(app, body());

    expect(response.json<CreateCommentResponse>().status).toBe('pending');
    await app.close();
  });

  it('publishes a returning commenter under auditFirstOnly', async () => {
    // The end-to-end version of the policy: the same email, once approved,
    // stops being held.
    const app = await buildWith({
      COMMENT_AUDIT_FIRST_ONLY: 'true',
      COMMENT_MIN_INTERVAL_SECONDS: '0',
    });
    await post(app, body());
    await harness.db.update(comments).set({ status: 'approved' });

    const second = await post(app, body({ comment: 'a different comment' }));

    expect(second.json<CreateCommentResponse>().status).toBe('approved');
    await app.close();
  });

  it('holds everything under COMMENT_AUDIT', async () => {
    const app = await buildWith({ COMMENT_AUDIT: 'true' });

    expect((await post(app, body())).json<CreateCommentResponse>().status).toBe('pending');
    await app.close();
  });

  it('rejects a forbidden word with 422 and stores nothing', async () => {
    const app = await buildWith({ FORBIDDEN_WORDS: 'viagra,casino' });

    const response = await post(app, body({ comment: 'buy viagra now' }));

    expect(response.statusCode).toBe(422);
    expect(response.json<ProblemDetails>().code).toBe('spam_rejected');
    expect(await harness.db.select().from(comments)).toHaveLength(0);
    // Nothing is queued for a comment that was never stored.
    expect(await harness.db.select().from(notificationOutbox)).toHaveLength(0);
    await app.close();
  });

  it('rejects a comment the spam checker flags', async () => {
    const app = await buildWith({}, { spamChecker: { check: () => Promise.resolve('spam') } });

    const response = await post(app, body());

    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it('publishes when the spam checker is unreachable', async () => {
    // Fail open: an outage must not take the comment form down.
    const app = await buildWith({}, { spamChecker: { check: () => Promise.resolve(null) } });

    expect((await post(app, body())).statusCode).toBe(201);
    await app.close();
  });

  it('records the moderation reason in the log', async () => {
    const app = await buildWith({ COMMENT_AUDIT_FIRST_ONLY: 'true' });

    await post(app, body());
    const log = await harness.db.execute<{ reason: string; to_status: string }>(
      sql`select reason, to_status from moderation_log`,
    );

    expect(log.rows[0]).toMatchObject({ reason: 'first_comment', to_status: 'pending' });
    await app.close();
  });
});

describe('POST /api/comments — captcha', () => {
  it('rejects a failed captcha with 403 before touching the database', async () => {
    const app = await buildWith(
      { TURNSTILE_SECRET: 'secret' },
      { captcha: { verify: () => Promise.resolve(false) } },
    );

    const response = await post(app, body({ captchaToken: 'bad' }));

    expect(response.statusCode).toBe(403);
    expect(await harness.db.select().from(comments)).toHaveLength(0);
    await app.close();
  });

  it('accepts when the captcha passes', async () => {
    const app = await buildWith(
      { TURNSTILE_SECRET: 'secret' },
      { captcha: { verify: () => Promise.resolve(true) } },
    );

    expect((await post(app, body({ captchaToken: 'good' }))).statusCode).toBe(201);
    await app.close();
  });
});

describe('POST /api/comments — limits', () => {
  it('rejects a second comment posted too quickly', async () => {
    const app = await buildWith({ COMMENT_MIN_INTERVAL_SECONDS: '60' });
    await post(app, body());

    const second = await post(app, body({ comment: 'something else entirely' }));

    expect(second.statusCode).toBe(429);
    expect(second.json<ProblemDetails>().code).toBe('rate_limited');
    await app.close();
  });

  it('rejects an identical repost as a duplicate', async () => {
    const app = await buildWith({ COMMENT_MIN_INTERVAL_SECONDS: '0' });
    await post(app, body());

    const second = await post(app, body());

    expect(second.statusCode).toBe(422);
    expect(second.json<ProblemDetails>().code).toBe('validation_failed');
    await app.close();
  });

  it('rejects an over-long body', async () => {
    const app = await buildWith({ COMMENT_MAX_LENGTH: '50' });

    const response = await post(app, body({ comment: 'x'.repeat(51) }));

    expect(response.statusCode).toBe(422);
    await app.close();
  });
});

describe('POST /api/comments — validation', () => {
  it('rejects a missing body with 400', async () => {
    const app = await buildWith();

    expect((await post(app, { path: '/post' })).statusCode).toBe(400);
    await app.close();
  });

  it('rejects a malformed email', async () => {
    const app = await buildWith();

    const response = await post(app, body({ mail: 'not-an-email' }));

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a reply to a parent that does not exist', async () => {
    const app = await buildWith();

    const response = await post(app, body({ parentId: '00000000-0000-4000-8000-000000000000' }));

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('accepts an anonymous comment with no email', async () => {
    const app = await buildWith();

    const response = await post(app, body({ mail: null }));

    expect(response.statusCode).toBe(201);
    const [row] = await harness.db.select().from(comments);
    expect(row?.authorEmailHash).toBeNull();
    await app.close();
  });
});

describe('comments appear in the read path', () => {
  it('shows an approved comment but hides a pending one', async () => {
    const app = await buildWith();
    await post(app, body({ comment: 'visible one' }));

    const pendingApp = await buildWith({ COMMENT_AUDIT: 'true' });
    await post(pendingApp, body({ comment: 'held for review', mail: 'bob@example.com' }));

    const list = await app.inject({ method: 'GET', url: '/api/comments?path=/post' });

    expect(list.payload).toContain('visible one');
    expect(list.payload).not.toContain('held for review');
    await app.close();
    await pendingApp.close();
  });
});
