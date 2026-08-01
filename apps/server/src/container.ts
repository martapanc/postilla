import type { Pool } from 'pg';
import { createDatabase, type Database } from './infrastructure/db/client.js';
import type { AppConfig } from './config/env.js';

/**
 * The composition root: the one place that knows which concrete adapter
 * satisfies which port. Everything else receives its collaborators as
 * arguments, which is what makes the layers testable in isolation.
 *
 * There is deliberately no global registry and no service locator.
 */
export interface Container {
  readonly config: AppConfig;
  readonly db: Database;
  readonly shutdown: () => Promise<void>;
}

export function createContainer(config: AppConfig): Container {
  const { db, pool }: { db: Database; pool: Pool } = createDatabase(config);

  return {
    config,
    db,
    shutdown: async () => {
      await pool.end();
    },
  };
}
