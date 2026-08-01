import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import type { AppConfig } from '../../config/env.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(config: AppConfig): { db: ReturnType<typeof drizzle>; pool: Pool } {
  const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    // Fail fast on an unreachable database rather than hanging the request.
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return { db, pool };
}
