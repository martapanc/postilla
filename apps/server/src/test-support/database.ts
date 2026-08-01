import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../infrastructure/db/schema.js';
import type { Database } from '../infrastructure/db/client.js';

/**
 * Integration tests run against a real Postgres — the one from
 * `docker compose up` locally, and the service container in CI — rather than
 * an in-memory substitute. Partial indexes, `ON CONFLICT`, recursive CTEs and
 * enum coercion are exactly the things a fake would get wrong, and they are
 * what these tests exist to check.
 *
 * (The plan called for testcontainers. A service container reaches the same
 * place with less machinery, since CI already provides one and the compose
 * file already provides the local equivalent.)
 */

export interface TestDatabase {
  db: Database;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export function connectTestDatabase(): TestDatabase {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for integration tests. Run `docker compose up -d` and source .env.',
    );
  }

  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return {
    db,
    /**
     * Truncating between tests is faster and less flaky than wrapping each in
     * a transaction, which would hide exactly the concurrency behaviour we
     * want to exercise. `reaction_kinds` is reference data seeded by a
     * migration and is deliberately left alone.
     */
    reset: async () => {
      await db.execute(
        sql`truncate table comments, reactions, reaction_baselines, pages, users, moderation_log, notification_outbox, sessions, user_verifications restart identity cascade`,
      );
    },
    close: async () => {
      await pool.end();
    },
  };
}
