import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * Migrations run as an explicit release step, never at app boot: two instances
 * starting at once must not race each other through the same DDL.
 *
 * The advisory lock makes concurrent runs safe anyway — the second waits for
 * the first, then finds nothing to do.
 */

const ADVISORY_LOCK_KEY = 8_360_001;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  try {
    console.warn('[migrate] acquiring advisory lock...');
    await db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);

    console.warn('[migrate] applying migrations...');
    await migrate(db, { migrationsFolder: './drizzle' });

    console.warn('[migrate] done.');
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
