import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  CommentCountResponse,
  ListCommentsResponse,
  PageStatsResponse,
  ProblemDetails,
  RecordPageviewResponse,
} from '@postilla/contract';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { createContainerFrom } from '../../container.js';
import { comments, pages } from '../../infrastructure/db/schema.js';
import { connectTestDatabase, type TestDatabase } from '../../test-support/database.js';

/**
 * Full-stack contract tests: real routing, real zod validation, real response
 * serialization, real database. Only the socket is skipped.
 */

let harness: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  harness = connectTestDatabase();
  const config = loadConfig({
    DATABASE_URL: process.env['DATABASE_URL'],
    SERVER_URL: 'http://localhost:8360',
    SITE_NAME: 'Test',
    SECRET_KEY: 'a'.repeat(32),
    LOG_LEVEL: 'fatal',
  });
  app = await buildApp(createContainerFrom(config, harness.db, () => Promise.resolve()));
});

afterAll(async () => {
  await app.close();
  await harness.close();
});

beforeEach(async () => await harness.reset());

async function seedThread(): Promise<{ pageId: string; rootId: string }> {
  const [page] = await harness.db
    .insert(pages)
    .values({ path: '/post', pageviews: 7 })
    .returning({ id: pages.id });
  const rootId = randomUUID();
  const pendingId = randomUUID();

  await harness.db.insert(comments).values([
    {
      id: rootId,
      pageId: page!.id,
      rootId,
      status: 'approved',
      bodyMarkdown: 'root',
      bodyHtml: '<p>root</p>',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorEmailHash: 'deadbeef',
      authorIp: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (secret)',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
    {
      id: randomUUID(),
      pageId: page!.id,
      parentId: rootId,
      rootId,
      status: 'approved',
      bodyMarkdown: 'reply',
      bodyHtml: '<p>reply</p>',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      createdAt: new Date('2025-01-02T00:00:00Z'),
    },
    {
      // A top-level comment is its own root; anything else violates the
      // self-referencing foreign key, as it should.
      id: pendingId,
      pageId: page!.id,
      rootId: pendingId,
      status: 'pending',
      bodyMarkdown: 'hidden',
      bodyHtml: '<p>hidden</p>',
      authorName: 'Mallory',
      createdAt: new Date('2025-01-03T00:00:00Z'),
    },
  ]);

  return { pageId: page!.id, rootId };
}

describe('GET /api/comments', () => {
  it('returns threads with replies nested under their root', async () => {
    await seedThread();

    const response = await app.inject({ method: 'GET', url: '/api/comments?path=/post' });
    const body = response.json<ListCommentsResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]!.root.authorName).toBe('Alice');
    expect(body.threads[0]!.replies).toHaveLength(1);
    expect(body.threads[0]!.replies[0]!.authorName).toBe('Bob');
    expect(body.totalComments).toBe(2);
  });

  it('never leaks author email, email hash, IP or user agent', async () => {
    await seedThread();

    const response = await app.inject({ method: 'GET', url: '/api/comments?path=/post' });

    // Asserted on the raw payload, not the parsed object, so a nested or
    // renamed field cannot slip past.
    expect(response.payload).not.toContain('alice@example.com');
    expect(response.payload).not.toContain('deadbeef');
    expect(response.payload).not.toContain('203.0.113.9');
    expect(response.payload).not.toContain('Mozilla');
  });

  it('omits comments awaiting moderation', async () => {
    await seedThread();

    const response = await app.inject({ method: 'GET', url: '/api/comments?path=/post' });

    expect(response.payload).not.toContain('Mallory');
    expect(response.payload).not.toContain('hidden');
  });

  it('normalizes the requested path', async () => {
    await seedThread();

    for (const path of ['/post', '/post/', '/Post', '/post?utm=x']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/comments?path=${encodeURIComponent(path)}`,
      });
      expect(response.json<ListCommentsResponse>().totalComments, path).toBe(2);
    }
  });

  it('returns an empty page rather than 404 for a page with no comments', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?path=/nothing-here' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      threads: [],
      totalComments: 0,
      pagination: { total: 0, totalPages: 1 },
    });
  });

  it('rejects a missing path with problem+json', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments' });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'validation_failed', status: 400 });
    expect(response.json<ProblemDetails>().errors?.length).toBeGreaterThan(0);
  });

  it('rejects a page size beyond the maximum', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/comments?path=/post&pageSize=1000',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ProblemDetails>().code).toBe('validation_failed');
  });

  it('rejects an unknown sort value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/comments?path=/post&sort=chaotic',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/pages', () => {
  it('reports pageviews, comment count and every reaction kind', async () => {
    await seedThread();

    const response = await app.inject({ method: 'GET', url: '/api/pages?paths=/post' });
    const [page] = response.json<PageStatsResponse>().pages;

    expect(response.statusCode).toBe(200);
    expect(page).toMatchObject({ path: '/post', pageviews: 7, commentCount: 2 });
    expect(page!.reactions).toHaveLength(5);
  });

  it('answers for several paths at once, including unknown ones', async () => {
    await seedThread();

    const response = await app.inject({ method: 'GET', url: '/api/pages?paths=/post,/unknown' });

    expect(response.json<PageStatsResponse>().pages.map((p) => p.path)).toEqual([
      '/post',
      '/unknown',
    ]);
  });

  it('rejects an empty path list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/pages?paths=' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/comments/count', () => {
  it('returns a count per requested path', async () => {
    await seedThread();

    const response = await app.inject({
      method: 'GET',
      url: '/api/comments/count?paths=/post,/empty',
    });
    const { counts } = response.json<CommentCountResponse>();

    expect(counts.find((c) => c.path === '/post')?.count).toBe(2);
    expect(counts.find((c) => c.path === '/empty')?.count).toBe(0);
  });
});

describe('POST /api/pageviews', () => {
  it('creates the page on first view and increments thereafter', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/pageviews',
      payload: { path: '/fresh' },
    });
    expect(first.json()).toEqual({ path: '/fresh', pageviews: 1 });

    const second = await app.inject({
      method: 'POST',
      url: '/api/pageviews',
      payload: { path: '/fresh' },
    });
    expect(second.json<RecordPageviewResponse>().pageviews).toBe(2);
  });

  it('returns the normalized path it recorded against', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pageviews',
      payload: { path: '/Fresh/?utm=x' },
    });

    expect(response.json<RecordPageviewResponse>().path).toBe('/fresh');
  });

  it('rejects a body with no path', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/pageviews', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json<ProblemDetails>().code).toBe('validation_failed');
  });
});
