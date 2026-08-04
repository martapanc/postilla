import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import { createCommentRepository } from './repositories/comment-repository.js';
import { createMarkdownRenderer } from '../markdown/renderer.js';

/**
 * Renders `body_html` for comments migrated from LeanCloud.
 *
 * The migrator deliberately stored an empty `body_html`: at the time it ran,
 * no renderer existed, and writing a guess would have been worse than writing
 * nothing. The markdown source is authoritative, so this is re-runnable and
 * safe — it only touches migrated rows whose HTML is still empty.
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  try {
    const renderer = createMarkdownRenderer();
    const updated = await createCommentRepository(db).backfillHtml((md) => renderer.render(md));
    console.warn(`[backfill] rendered ${String(updated)} comment(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[backfill] failed:', error);
  process.exit(1);
});
