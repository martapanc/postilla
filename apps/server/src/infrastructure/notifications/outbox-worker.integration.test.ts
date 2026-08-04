import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { notificationOutbox } from '../db/schema.js';
import { createOutboxWorker } from './outbox-worker.js';
import { connectTestDatabase, type TestDatabase } from '../../test-support/database.js';
import type { NotificationChannel } from './channels.js';
import type { CommentCreatedEvent } from '../../domain/notifications/events.js';
import type { RenderContext } from '../../domain/notifications/render.js';

let harness: TestDatabase;

beforeAll(() => {
  harness = connectTestDatabase();
});
afterAll(async () => await harness.close());
beforeEach(async () => await harness.reset());

const context: RenderContext = {
  siteName: 'Test Site',
  siteUrl: 'https://blog.example',
  adminUrl: 'https://comments.example/admin',
};

const event: CommentCreatedEvent = {
  type: 'comment.created',
  commentId: 'c1',
  path: '/post',
  pageTitle: 'A Post',
  authorName: 'Alice',
  bodyMarkdown: 'Hello there',
  status: 'approved',
  replyToAuthorName: null,
};

/** Records what it was asked to send, and can be told to fail. */
function recordingChannel(
  id: string,
  behaviour: { failTimes?: number } = {},
): NotificationChannel & { sent: { subject: string; body: string }[]; calls: number } {
  let remaining = behaviour.failTimes ?? 0;
  const channel = {
    id,
    format: 'plain-text' as const,
    sent: [] as { subject: string; body: string }[],
    calls: 0,
    send(message: { subject: string; body: string }) {
      channel.calls += 1;
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error(`${id} is unavailable`));
      }
      channel.sent.push(message);
      return Promise.resolve();
    },
  };
  return channel;
}

async function queue(over: Partial<{ dedupeKey: string; payload: unknown }> = {}): Promise<void> {
  await harness.db.insert(notificationOutbox).values({
    eventType: 'comment.created',
    payload: over.payload ?? event,
    ...(over.dedupeKey ? { dedupeKey: over.dedupeKey } : {}),
  });
}

async function rows() {
  return harness.db.select().from(notificationOutbox);
}

describe('outbox worker', () => {
  it('delivers a queued notification and marks it delivered', async () => {
    const channel = recordingChannel('test');
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    await queue();

    const handled = await worker.runOnce();

    expect(handled).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.body).toContain('Alice');
    expect((await rows())[0]?.deliveredAt).not.toBeNull();
  });

  it('renders once per channel, in each channel’s own format', async () => {
    const a = recordingChannel('a');
    const b = recordingChannel('b');
    const worker = createOutboxWorker({ db: harness.db, channels: [a, b], context, locale: 'en' });
    await queue();

    await worker.runOnce();

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('renders in the configured locale', async () => {
    const channel = recordingChannel('test');
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'it',
    });
    await queue();

    await worker.runOnce();

    expect(channel.sent[0]?.body).toContain('Nuovo commento');
  });

  it('does not deliver the same row twice', async () => {
    const channel = recordingChannel('test');
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    await queue();

    await worker.runOnce();
    await worker.runOnce();

    expect(channel.calls).toBe(1);
  });

  it('retries a failed delivery with backoff rather than dropping it', async () => {
    const channel = recordingChannel('flaky', { failTimes: 1 });
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    await queue();

    await worker.runOnce();

    const [row] = await rows();
    expect(row?.deliveredAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('unavailable');
    // Backed off, so an immediate second pass finds nothing to claim.
    expect(await worker.runOnce()).toBe(0);
  });

  it('eventually delivers once the channel recovers', async () => {
    const channel = recordingChannel('flaky', { failTimes: 1 });
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    await queue();

    await worker.runOnce();
    // Simulate the backoff elapsing.
    await harness.db.execute(sql`update notification_outbox set available_at = now()`);
    await worker.runOnce();

    expect(channel.sent).toHaveLength(1);
    expect((await rows())[0]?.deliveredAt).not.toBeNull();
  });

  it('gives up after maxAttempts instead of retrying forever', async () => {
    const channel = recordingChannel('broken', { failTimes: 99 });
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
      maxAttempts: 3,
    });
    await queue();

    for (let i = 0; i < 5; i += 1) {
      await harness.db.execute(sql`update notification_outbox set available_at = now()`);
      await worker.runOnce();
    }

    expect((await rows())[0]?.attempts).toBe(3);
    expect(channel.calls).toBe(3);
  });

  it('does nothing when no channel is configured', async () => {
    const worker = createOutboxWorker({ db: harness.db, channels: [], context, locale: 'en' });
    await queue();

    expect(await worker.runOnce()).toBe(0);
    // Left queued, so configuring a channel later still delivers it.
    expect((await rows())[0]?.deliveredAt).toBeNull();
  });

  it('is safe to run concurrently — no row is delivered twice', async () => {
    // `FOR UPDATE SKIP LOCKED` is what makes two workers safe against one table.
    const channel = recordingChannel('test');
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    for (let i = 0; i < 5; i += 1) await queue();

    await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);

    expect(channel.calls).toBe(5);
    const delivered = (await rows()).filter((r) => r.deliveredAt !== null);
    expect(delivered).toHaveLength(5);
  });

  it('coalesces reactions sharing a dedupe key into one undelivered row', async () => {
    const reaction = {
      type: 'reaction.added',
      path: '/post',
      pageTitle: null,
      kindKey: 'heart',
      emoji: '❤️',
      kindTotal: 1,
      pageTotal: 1,
      delta: 1,
    };

    await harness.db
      .insert(notificationOutbox)
      .values({ eventType: 'reaction.added', payload: reaction, dedupeKey: 'r:1' });

    // A second click in the same window updates the payload rather than
    // queueing another message.
    await harness.db
      .insert(notificationOutbox)
      .values({
        eventType: 'reaction.added',
        payload: { ...reaction, kindTotal: 2, pageTotal: 2 },
        dedupeKey: 'r:1',
      })
      .onConflictDoUpdate({
        target: notificationOutbox.dedupeKey,
        // The index is partial; the conflict target must repeat its predicate.
        targetWhere: sql`${notificationOutbox.deliveredAt} is null`,
        set: { payload: { ...reaction, kindTotal: 2, pageTotal: 2 } },
      });

    expect(await rows()).toHaveLength(1);

    const channel = recordingChannel('test');
    const worker = createOutboxWorker({
      db: harness.db,
      channels: [channel],
      context,
      locale: 'en',
    });
    await worker.runOnce();

    // The message that goes out carries the final counts, not the first.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.body).toContain('2');
  });
});
