import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * `/health` answers "is this process alive" — it must never touch the database,
 * or a database blip will cause the orchestrator to kill a healthy app.
 * `/ready` answers "can this process serve traffic", and so does.
 */

const healthResponse = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
});

const readyResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      latencyMs: z.number().optional(),
      error: z.string().optional(),
    }),
    migrations: z.object({
      ok: z.boolean(),
      applied: z.number().optional(),
      error: z.string().optional(),
    }),
  }),
  /**
   * Which notification channels are configured. Surfaced because "Telegram
   * silently stopped being configured" is otherwise invisible until someone
   * notices they stopped getting messages.
   */
  channels: z.array(z.string()),
  pendingNotifications: z.number().int().optional(),
});

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/health', { schema: { response: { 200: healthResponse } } }, () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  typed.get(
    '/ready',
    { schema: { response: { 200: readyResponse, 503: readyResponse } } },
    async (_request, reply) => {
      const { db } = app.container;

      const database = await timed(async () => {
        await db.execute(sql`select 1`);
      });

      // Reports how many migrations Drizzle has recorded, so a deploy that
      // forgot `pnpm db:migrate` is visible rather than mysterious.
      const migrations = await timed(async () => {
        const result = await db.execute<{ count: string }>(
          sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
        );
        return Number(result.rows[0]?.count ?? 0);
      });

      const pending = await timed(async () => {
        const result = await db.execute<{ count: string }>(
          sql`select count(*)::text as count from notification_outbox where delivered_at is null`,
        );
        return Number(result.rows[0]?.count ?? 0);
      });

      const ok = database.ok && migrations.ok;

      const body = {
        channels: app.container.channels.map((channel) => channel.id),
        ...(pending.ok ? { pendingNotifications: pending.value } : {}),
        status: ok ? ('ready' as const) : ('degraded' as const),
        checks: {
          database: database.ok
            ? { ok: true, latencyMs: database.latencyMs }
            : { ok: false, error: database.error },
          migrations: migrations.ok
            ? { ok: true, applied: migrations.value }
            : { ok: false, error: migrations.error },
        },
      };

      return reply.status(ok ? 200 : 503).send(body);
    },
  );
}

type Timed<T> =
  { ok: true; value: T; latencyMs: number } | { ok: false; error: string; latencyMs: number };

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, latencyMs: Math.round(performance.now() - start) };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
