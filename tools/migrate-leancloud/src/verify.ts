import { sql } from 'drizzle-orm';
import type { Db } from './load.js';
import { normalizePath } from './transform.js';
import type { LeanComment, LeanCounter, LeanUser } from './records.js';

/**
 * Reconciles what landed in Postgres against the LeanCloud export.
 *
 * The migration is not "done" when it runs without throwing — it is done when
 * every one of these checks passes. Anything less and comments have quietly
 * gone missing or attached themselves to the wrong page.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function verify(
  db: Db,
  source: { comments: LeanComment[]; counters: LeanCounter[]; users: LeanUser[] },
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const scalar = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await db.execute<{ v: string }>(query);
    return Number(result.rows[0]?.v ?? 0);
  };

  // ── Row counts ───────────────────────────────────────────────────────────
  const commentCount = await scalar(sql`select count(*)::text as v from comments`);
  add(
    'comment count matches export',
    commentCount === source.comments.length,
    `${commentCount} in database, ${source.comments.length} in export`,
  );

  const userCount = await scalar(sql`select count(*)::text as v from users`);
  add(
    'user count matches export',
    userCount === source.users.length,
    `${userCount} in database, ${source.users.length} in export`,
  );

  const expectedPages = new Set([
    ...source.counters.map((c) => normalizePath(c.url)),
    ...source.comments.map((c) => normalizePath(c.url)),
  ]);
  const pageCount = await scalar(sql`select count(*)::text as v from pages`);
  add(
    'page count matches the union of counter and comment urls',
    pageCount === expectedPages.size,
    `${pageCount} in database, ${expectedPages.size} expected`,
  );

  // ── Totals ───────────────────────────────────────────────────────────────
  const expectedViews = source.counters.reduce((sum, c) => sum + c.time, 0);
  const actualViews = await scalar(sql`select coalesce(sum(pageviews),0)::text as v from pages`);
  add(
    'total pageviews match',
    actualViews === expectedViews,
    `${actualViews} in database, ${expectedViews} in export`,
  );

  let expectedReactions = 0;
  for (const counter of source.counters) {
    for (let i = 0; i <= 8; i += 1) {
      const value = counter[`reaction${i}` as keyof LeanCounter];
      if (typeof value === 'number' && value > 0) expectedReactions += value;
    }
  }
  const actualReactions = await scalar(
    sql`select coalesce(sum(count),0)::text as v from reaction_baselines`,
  );
  add(
    'total reactions match',
    actualReactions === expectedReactions,
    `${actualReactions} in database, ${expectedReactions} in export`,
  );

  // ── Per-page comment counts ──────────────────────────────────────────────
  const expectedPerPage = new Map<string, number>();
  for (const comment of source.comments) {
    const path = normalizePath(comment.url);
    expectedPerPage.set(path, (expectedPerPage.get(path) ?? 0) + 1);
  }
  const perPage = await db.execute<{ path: string; n: string }>(
    sql`select p.path as path, count(c.id)::text as n
        from pages p join comments c on c.page_id = p.id
        group by p.path`,
  );
  const mismatched = perPage.rows.filter(
    (row) => Number(row.n) !== (expectedPerPage.get(row.path) ?? 0),
  );
  add(
    'per-page comment counts match',
    mismatched.length === 0 && perPage.rows.length === expectedPerPage.size,
    mismatched.length === 0
      ? `${perPage.rows.length} pages with comments, all matching`
      : `mismatched: ${mismatched.map((r) => r.path).join(', ')}`,
  );

  // ── Structural invariants ────────────────────────────────────────────────
  const orphans = await scalar(
    sql`select count(*)::text as v from comments c
        where (c.parent_id is not null and not exists (select 1 from comments p where p.id = c.parent_id))
           or not exists (select 1 from comments r where r.id = c.root_id)`,
  );
  add('no orphaned parent or root references', orphans === 0, `${orphans} orphan(s)`);

  // root_id must equal the transitive root reached by following parent_id.
  const badRoots = await scalar(
    sql`with recursive walk as (
          select id, parent_id, root_id, id as origin from comments
          union all
          select c.id, c.parent_id, c.root_id, w.origin
          from comments c join walk w on c.id = w.parent_id
        )
        select count(*)::text as v from (
          select origin, root_id, (array_agg(id order by parent_id nulls first))[1] as computed_root
          from walk group by origin, root_id
        ) t where t.root_id <> t.computed_root`,
  );
  add('root_id equals the transitive root for every comment', badRoots === 0, `${badRoots} wrong`);

  const selfParent = await scalar(
    sql`select count(*)::text as v from comments where parent_id = id`,
  );
  add('no comment is its own parent', selfParent === 0, `${selfParent} found`);

  const nullMarkdown = await scalar(
    sql`select count(*)::text as v from comments where body_markdown is null or body_markdown = ''`,
  );
  add('every comment has a body', nullMarkdown === 0, `${nullMarkdown} empty`);

  // ── Content fidelity ─────────────────────────────────────────────────────
  const rows = await db.execute<{
    legacy_object_id: string;
    body_markdown: string;
    created_at: Date;
  }>(
    sql`select legacy_object_id, body_markdown, created_at from comments where legacy_object_id is not null`,
  );
  const byLegacy = new Map(rows.rows.map((r) => [r.legacy_object_id, r]));

  const bodyMismatches = source.comments.filter(
    (c) => byLegacy.get(c.objectId)?.body_markdown !== c.comment,
  );
  add(
    'comment bodies are byte-identical',
    bodyMismatches.length === 0,
    bodyMismatches.length === 0
      ? `all ${source.comments.length} match`
      : `${bodyMismatches.length} differ: ${bodyMismatches
          .slice(0, 5)
          .map((c) => c.objectId)
          .join(', ')}`,
  );

  // The highest-risk failure mode: a timezone offset applied anywhere in the
  // chain shifts every comment without any error being raised.
  const timeMismatches = source.comments.filter((c) => {
    const stored = byLegacy.get(c.objectId)?.created_at;
    return !stored || new Date(stored).getTime() !== c.insertedAt.getTime();
  });
  add(
    'timestamps preserve the exact UTC instant of insertedAt',
    timeMismatches.length === 0,
    timeMismatches.length === 0
      ? `all ${source.comments.length} match to the millisecond`
      : `${timeMismatches.length} shifted: ${timeMismatches
          .slice(0, 5)
          .map((c) => c.objectId)
          .join(', ')}`,
  );

  const missing = source.comments.filter((c) => !byLegacy.has(c.objectId));
  add(
    'every exported comment is present by objectId',
    missing.length === 0,
    missing.length === 0 ? 'all present' : `missing: ${missing.map((c) => c.objectId).join(', ')}`,
  );

  // ── Admin account ────────────────────────────────────────────────────────
  const admins = await db.execute<{ totp_secret: string | null; password_algo: string }>(
    sql`select totp_secret, password_algo from users where role = 'admin'`,
  );
  const sourceAdmin = source.users.find((u) => u.type === 'administrator');
  if (sourceAdmin) {
    const stored = admins.rows[0];
    add(
      'admin TOTP secret carried across byte-for-byte',
      stored?.totp_secret === sourceAdmin['2fa'],
      sourceAdmin['2fa']
        ? stored?.totp_secret === sourceAdmin['2fa']
          ? 'matches'
          : 'MISMATCH — the admin would be locked out'
        : 'no TOTP configured in the source',
    );
    add(
      'admin password marked for rehash on first login',
      stored?.password_algo === 'phpass',
      `password_algo is ${stored?.password_algo ?? 'missing'}`,
    );
  }

  return checks;
}

export function renderChecks(checks: Check[]): string {
  const lines = checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.name}\n      ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push(
    '',
    failed === 0
      ? `  All ${checks.length} checks passed.`
      : `  ${failed} of ${checks.length} checks FAILED.`,
  );
  return lines.join('\n');
}
