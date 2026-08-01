import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { leanCommentSchema, leanCounterSchema, leanUserSchema } from './records.js';
import {
  buildPages,
  transformComments,
  transformReactions,
  transformUsers,
  type Note,
  type Rejection,
} from './transform.js';
import { load, truncateAll } from './load.js';
import { renderChecks, verify } from './verify.js';
import type { LeanComment, LeanCounter, LeanUser } from './records.js';
import type { z } from 'zod';

/**
 * Usage:
 *   pnpm migrate transform <dir>          parse and report, touching no database
 *   pnpm migrate load <dir> [--fresh]     transform then write (idempotent)
 *   pnpm migrate verify <dir>             reconcile the database against the export
 *
 * <dir> holds the LeanCloud console exports, matched by filename prefix:
 * Comment*.json, Counter*.json, Users*.json.
 */

const USAGE = `
migrate-leancloud <command> <export-dir> [--fresh]

  transform   Parse and validate the export; report what would be written.
  load        Transform, then upsert into Postgres. Safe to re-run.
  verify      Reconcile the database against the export.

  --fresh     (load only) Truncate migrated tables first.
`;

function findExport(dir: string, prefix: string): string {
  const match = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!match) throw new Error(`No ${prefix}*.json found in ${dir}`);
  return join(dir, match);
}

function parseClass<T extends z.ZodType>(
  path: string,
  schema: T,
  className: Rejection['class'],
): { records: z.infer<T>[]; rejections: Rejection[] } {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`${path} is not a JSON array; is this a LeanCloud class export?`);
  }

  const records: z.infer<T>[] = [];
  const rejections: Rejection[] = [];

  for (const [i, record] of raw.entries()) {
    const result = schema.safeParse(record);
    if (result.success) {
      records.push(result.data);
    } else {
      const id =
        typeof record === 'object' && record !== null && 'objectId' in record
          ? String((record as { objectId: unknown }).objectId)
          : `index ${i}`;
      rejections.push({
        class: className,
        objectId: id,
        reason: result.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
      });
    }
  }

  return { records, rejections };
}

function readExports(dir: string): {
  comments: LeanComment[];
  counters: LeanCounter[];
  users: LeanUser[];
  rejections: Rejection[];
} {
  const c = parseClass(findExport(dir, 'Comment'), leanCommentSchema, 'Comment');
  const n = parseClass(findExport(dir, 'Counter'), leanCounterSchema, 'Counter');
  const u = parseClass(findExport(dir, 'Users'), leanUserSchema, 'Users');

  return {
    comments: c.records,
    counters: n.records,
    users: u.records,
    rejections: [...c.rejections, ...n.rejections, ...u.rejections],
  };
}

function report(label: string, notes: Note[], rejections: Rejection[]): void {
  console.log(`\n${label}`);
  for (const note of notes) console.log(`  · ${note.kind}: ${note.detail}`);
  for (const r of rejections) console.log(`  ✗ REJECTED ${r.class}/${r.objectId}: ${r.reason}`);
}

function connect(): { db: ReturnType<typeof drizzle>; pool: Pool } {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url, max: 1 });
  return { db: drizzle(pool), pool };
}

async function main(): Promise<void> {
  const [command, dir] = process.argv.slice(2);
  const fresh = process.argv.includes('--fresh');

  if (!command || !dir || !['transform', 'load', 'verify'].includes(command)) {
    console.log(USAGE);
    process.exit(1);
  }

  const source = readExports(dir);
  const { pages, notes: pageNotes } = buildPages(source.counters, source.comments);
  const commentResult = transformComments(source.comments);
  const reactionResult = transformReactions(source.counters);
  const userResult = transformUsers(source.users);

  const allRejections = [...source.rejections, ...commentResult.rejections];

  console.log('Read from export:');
  console.log(`  Comment  ${source.comments.length}`);
  console.log(`  Counter  ${source.counters.length}`);
  console.log(`  Users    ${source.users.length}`);

  report('Pages', pageNotes, []);
  report('Comments', commentResult.notes, commentResult.rejections);
  report('Reactions', reactionResult.notes, []);
  report('Users', userResult.notes, []);

  if (allRejections.length > 0) {
    console.error(`\n${allRejections.length} record(s) rejected. Nothing was written.`);
    process.exit(1);
  }

  console.log('\nWould write:');
  console.log(`  pages              ${pages.size}`);
  console.log(`  users              ${userResult.rows.length}`);
  console.log(`  comments           ${commentResult.rows.length}`);
  console.log(`  reaction_baselines ${reactionResult.rows.length}`);

  if (command === 'transform') return;

  const { db, pool } = connect();
  try {
    if (command === 'load') {
      if (fresh) {
        console.log('\n--fresh: truncating migrated tables');
        await truncateAll(db);
      }
      const counts = await load(db, {
        pages,
        users: userResult.rows,
        comments: commentResult.rows,
        reactions: reactionResult.rows,
      });
      console.log('\nWrote:', counts);
    }

    console.log('\nVerification');
    const checks = await verify(db, source);
    console.log(renderChecks(checks));
    if (checks.some((c) => !c.ok)) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nMigration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
