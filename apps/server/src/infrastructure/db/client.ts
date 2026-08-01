import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import type { AppConfig } from '../../config/env.js';

/**
 * The schema is bound to the client so repositories get typed relations and
 * `db.query.*` helpers rather than untyped SQL results.
 */
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(config: AppConfig): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    // Fail fast on an unreachable database rather than hanging the request.
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return { db, pool };
}
