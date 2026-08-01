import type { Pool } from 'pg';
import { createDatabase, type Database } from './infrastructure/db/client.js';
import { createCommentRepository } from './infrastructure/db/repositories/comment-repository.js';
import { createPageRepository } from './infrastructure/db/repositories/page-repository.js';
import { createListComments } from './application/use-cases/list-comments.js';
import { createGetPageStats, createRecordPageview } from './application/use-cases/page-stats.js';
import type { CommentRepository, PageRepository } from './ports/repositories.js';
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
  readonly repositories: {
    readonly comments: CommentRepository;
    readonly pages: PageRepository;
  };
  readonly useCases: {
    readonly listComments: ReturnType<typeof createListComments>;
    readonly getPageStats: ReturnType<typeof createGetPageStats>;
    readonly recordPageview: ReturnType<typeof createRecordPageview>;
  };
  readonly shutdown: () => Promise<void>;
}

/** Everything above the database, wired by hand. */
export function createContainerFrom(
  config: AppConfig,
  db: Database,
  shutdown: () => Promise<void>,
): Container {
  const repositories = {
    comments: createCommentRepository(db),
    pages: createPageRepository(db),
  };

  return {
    config,
    db,
    repositories,
    useCases: {
      listComments: createListComments(repositories.comments),
      getPageStats: createGetPageStats(repositories.pages),
      recordPageview: createRecordPageview(repositories.pages),
    },
    shutdown,
  };
}

export function createContainer(config: AppConfig): Container {
  const { db, pool }: { db: Database; pool: Pool } = createDatabase(config);
  return createContainerFrom(config, db, async () => {
    await pool.end();
  });
}
