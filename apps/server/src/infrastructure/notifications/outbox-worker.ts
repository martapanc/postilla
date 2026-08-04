import { sql } from 'drizzle-orm';
import { renderNotification, type RenderContext } from '../../domain/notifications/render.js';
import type { Locale } from '@postilla/i18n';
import type { NotificationEvent } from '../../domain/notifications/events.js';
import type { NotificationChannel } from './channels.js';
import type { Database } from '../db/client.js';

/**
 * Drains the transactional outbox.
 *
 * The plan called for pg-boss. It is not used: the outbox table already *is*
 * the queue — written in the same transaction as the comment, which is the
 * property that matters — and pg-boss would add a second queue, its own
 * schema, and a copy of every message alongside the one we already have.
 * A poller over the table we own is less machinery for the same guarantee.
 *
 * Delivery is at-least-once. `FOR UPDATE SKIP LOCKED` means several workers
 * can drain the same table without handing each other the same row.
 */

export interface OutboxWorkerOptions {
  db: Database;
  channels: NotificationChannel[];
  context: RenderContext;
  locale: Locale;
  /** How often to look for work when the last pass found nothing. */
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  log?: {
    info: (details: Record<string, unknown>, message: string) => void;
    error: (details: Record<string, unknown>, message: string) => void;
  };
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  payload: NotificationEvent;
  attempts: number;
}

export interface OutboxWorker {
  /** Processes one batch and returns how many rows were handled. */
  runOnce: () => Promise<number>;
  start: () => void;
  stop: () => Promise<void>;
}

export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const {
    db,
    channels,
    context,
    locale,
    pollIntervalMs = 5_000,
    batchSize = 20,
    maxAttempts = 5,
    log,
  } = options;

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<number> {
    if (channels.length === 0) return 0;

    // Claim and deliver inside one transaction: the row stays locked until the
    // outcome is recorded, so a crash mid-send leaves it claimable again
    // rather than half-processed.
    return db.transaction(async (tx) => {
      const claimed = await tx.execute<OutboxRow>(sql`
        select id, event_type, payload, attempts
        from notification_outbox
        where delivered_at is null
          and available_at <= now()
          and attempts < ${maxAttempts}
        order by available_at
        limit ${batchSize}
        for update skip locked
      `);

      for (const row of claimed.rows) {
        const event = row.payload;

        try {
          // The payload comes back from JSONB, so its shape is a runtime
          // question no matter what the type says. Checking here turns a
          // malformed row into a legible failure on that row, instead of a
          // `Cannot read properties of undefined` that says nothing about
          // which event was bad.
          if (!isKnownEvent(event)) {
            throw new Error(
              `Unrecognized notification payload (event_type=${row.event_type}); it will not be retried.`,
            );
          }

          // One rendering pass per channel, because each wants its own format.
          await Promise.all(
            channels.map(async (channel) => {
              const message = renderNotification(event, channel.format, locale, context);
              await channel.send(message);
            }),
          );

          await tx.execute(
            sql`update notification_outbox set delivered_at = now(), last_error = null where id = ${row.id}`,
          );
          log?.info({ id: row.id, eventType: row.event_type }, 'notification delivered');
        } catch (error: unknown) {
          const attempts = row.attempts + 1;
          const message = error instanceof Error ? error.message : String(error);

          // Exponential backoff, so a flapping webhook is retried patiently
          // rather than hammered.
          const backoffSeconds = Math.min(3600, 30 * 2 ** (attempts - 1));

          await tx.execute(sql`
            update notification_outbox
            set attempts = ${attempts},
                last_error = ${message},
                available_at = now() + ${`${String(backoffSeconds)} seconds`}::interval
            where id = ${row.id}
          `);

          log?.error(
            { id: row.id, attempts, maxAttempts, backoffSeconds, err: message },
            attempts >= maxAttempts
              ? 'notification permanently failed'
              : 'notification delivery failed, will retry',
          );
        }
      }

      return claimed.rows.length;
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), pollIntervalMs);
    // Never hold the process open just to poll.
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;

    try {
      // Keep draining while there is work, so a burst is not paced by the poll
      // interval.
      let handled = 0;
      do {
        handled = await runOnce();
      } while (handled === batchSize && !stopped);
    } catch (error: unknown) {
      log?.error({ err: error }, 'outbox worker pass failed');
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    runOnce,
    start: () => {
      stopped = false;
      void tick();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let an in-flight pass finish so a delivery is not abandoned mid-send.
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

const KNOWN_EVENT_TYPES = new Set(['comment.created', 'reaction.added']);

function isKnownEvent(payload: unknown): payload is NotificationEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    typeof payload.type === 'string' &&
    KNOWN_EVENT_TYPES.has(payload.type)
  );
}
