import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PageStatsResponse, RecordReactionResponse } from '@postilla/contract';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { createContainerFrom } from '../../container.js';
import { notificationOutbox, pages, reactionBaselines } from '../../infrastructure/db/schema.js';
import { connectTestDatabase, type TestDatabase } from '../../test-support/database.js';
import type { ReactionAddedEvent } from '../../domain/notifications/events.js';

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

async function react(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/reactions', payload });
}

async function outbox() {
  return harness.db.select().from(notificationOutbox);
}

describe('POST /api/reactions', () => {
  it('records a reaction and returns both totals', async () => {
    const response = await react({ path: '/post', kind: 'heart' });

    expect(response.statusCode).toBe(200);
    expect(response.json<RecordReactionResponse>()).toMatchObject({
      kind: 'heart',
      kindTotal: 1,
      pageTotal: 1,
      active: true,
    });
  });

  it('creates the page on first reaction', async () => {
    await react({ path: '/Brand-New/?utm=x', kind: 'heart' });

    const [page] = await harness.db.select().from(pages);
    expect(page?.path).toBe('/brand-new');
  });

  it('is idempotent for the same visitor', async () => {
    // The old system stored bare counters, so one visitor could inflate a
    // count indefinitely. A reaction is now a row keyed by visitor.
    await react({ path: '/post', kind: 'heart' });
    const second = await react({ path: '/post', kind: 'heart' });

    expect(second.json<RecordReactionResponse>().kindTotal).toBe(1);
  });

  it('can be toggled off', async () => {
    await react({ path: '/post', kind: 'heart' });
    const removed = await react({ path: '/post', kind: 'heart', remove: true });

    expect(removed.json<RecordReactionResponse>()).toMatchObject({
      kindTotal: 0,
      active: false,
    });
  });

  it('counts kinds separately but sums them into the page total', async () => {
    await react({ path: '/post', kind: 'heart' });
    const fire = await react({ path: '/post', kind: 'fire' });

    expect(fire.json<RecordReactionResponse>()).toMatchObject({
      kind: 'fire',
      kindTotal: 1,
      pageTotal: 2,
    });
  });

  it('adds live reactions on top of a migrated baseline', async () => {
    // LeanCloud totals arrive with no rows behind them, so both sources count.
    const [page] = await harness.db
      .insert(pages)
      .values({ path: '/post' })
      .returning({ id: pages.id });
    await harness.db
      .insert(reactionBaselines)
      .values({ pageId: page!.id, kindKey: 'heart', count: 32 });

    const response = await react({ path: '/post', kind: 'heart' });

    expect(response.json<RecordReactionResponse>().kindTotal).toBe(33);
  });

  it('rejects an unknown reaction kind with 404', async () => {
    const response = await react({ path: '/post', kind: 'not-a-reaction' });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a missing kind with 400', async () => {
    expect((await react({ path: '/post' })).statusCode).toBe(400);
  });

  it('appears in the page stats read path', async () => {
    await react({ path: '/post', kind: 'heart' });

    const stats = await app.inject({ method: 'GET', url: '/api/pages?paths=/post' });
    const [page] = stats.json<PageStatsResponse>().pages;

    expect(page?.reactions.find((r) => r.key === 'heart')?.count).toBe(1);
  });
});

describe('reaction notifications', () => {
  it('queues one notification for a new reaction', async () => {
    await react({ path: '/post', kind: 'heart' });

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('reaction.added');
  });

  it('coalesces a burst from one visitor into a single message', async () => {
    // A visitor clicking repeatedly must not produce a message per click.
    for (let i = 0; i < 10; i += 1) await react({ path: '/post', kind: 'heart' });

    expect(await outbox()).toHaveLength(1);
  });

  it('carries the final counts, not the first', async () => {
    await react({ path: '/post', kind: 'heart' });
    await react({ path: '/post', kind: 'fire' });

    const rows = await harness.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.eventType, 'reaction.added'));

    // Two kinds are two separate messages, each with its own per-kind count
    // and the shared page total.
    const events = rows.map((r) => r.payload as ReactionAddedEvent);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kindTotal === 1)).toBe(true);
    expect(Math.max(...events.map((e) => e.pageTotal))).toBe(2);
  });

  it('reports the per-kind and page totals as distinct figures', async () => {
    // The bug this replaces: one call site reported the per-kind count, the
    // other the sum across all kinds, so the same message meant two things.
    await react({ path: '/post', kind: 'heart' });
    await react({ path: '/post', kind: 'fire' });

    const rows = await harness.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.eventType, 'reaction.added'));
    const fire = rows.map((r) => r.payload as ReactionAddedEvent).find((e) => e.kindKey === 'fire');

    expect(fire?.kindTotal).toBe(1);
    expect(fire?.pageTotal).toBe(2);
  });

  it('queues nothing when a reaction is toggled off', async () => {
    await react({ path: '/post', kind: 'heart' });
    await harness.db.delete(notificationOutbox);

    await react({ path: '/post', kind: 'heart', remove: true });

    expect(await outbox()).toHaveLength(0);
  });

  it('queues nothing when the same visitor re-clicks an existing reaction', async () => {
    await react({ path: '/post', kind: 'heart' });
    await harness.db.delete(notificationOutbox);

    await react({ path: '/post', kind: 'heart' });

    expect(await outbox()).toHaveLength(0);
  });
});
