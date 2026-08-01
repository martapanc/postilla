import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { comments, pages, reactionBaselines, reactionKinds, users } from '@postilla/server/schema';
import type { BaselineRow, CommentRow, PageRow, UserRow } from './transform.js';

/**
 * Writes transformed rows into Postgres.
 *
 * Every write is an upsert keyed on the LeanCloud objectId (or the page path),
 * so the whole migration can be re-run — which is what makes the cutover-day
 * delta pass safe: export since the last run, transform, load, and only the
 * changes land.
 */

/** What `drizzle(pool)` actually returns when no schema object is passed. */
export type Db = NodePgDatabase<Record<string, unknown>>;

export interface LoadCounts {
  pages: number;
  users: number;
  comments: number;
  reactionBaselines: number;
}

export async function load(
  db: Db,
  data: {
    pages: Map<string, PageRow>;
    users: UserRow[];
    comments: CommentRow[];
    reactions: BaselineRow[];
  },
): Promise<LoadCounts> {
  return db.transaction(async (tx) => {
    // ── Pages ────────────────────────────────────────────────────────────────
    const pageIdByPath = new Map<string, string>();
    for (const page of data.pages.values()) {
      const [row] = await tx
        .insert(pages)
        .values({
          path: page.path,
          pageviews: page.pageviews,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        })
        .onConflictDoUpdate({
          target: pages.path,
          set: { pageviews: page.pageviews, updatedAt: page.updatedAt },
        })
        .returning({ id: pages.id });
      if (row) pageIdByPath.set(page.path, row.id);
    }

    // ── Users ────────────────────────────────────────────────────────────────
    const userIdByLegacy = new Map<string, string>();
    for (const user of data.users) {
      const [row] = await tx
        .insert(users)
        .values(user)
        .onConflictDoUpdate({
          target: users.legacyObjectId,
          set: {
            displayName: user.displayName,
            email: user.email,
            role: user.role,
            updatedAt: user.updatedAt,
          },
        })
        .returning({ id: users.id });
      if (row) userIdByLegacy.set(user.legacyObjectId, row.id);
    }

    // ── Comments ─────────────────────────────────────────────────────────────
    // Ids are generated up front so parent and root can be resolved without a
    // second UPDATE pass, and rows are inserted parents-first so the
    // self-referencing foreign keys are satisfied as we go.
    const existing = await tx
      .select({ id: comments.id, legacyObjectId: comments.legacyObjectId })
      .from(comments);
    const idByLegacy = new Map<string, string>();
    for (const row of existing) {
      if (row.legacyObjectId) idByLegacy.set(row.legacyObjectId, row.id);
    }
    for (const comment of data.comments) {
      if (!idByLegacy.has(comment.legacyObjectId)) {
        idByLegacy.set(comment.legacyObjectId, randomUUID());
      }
    }

    for (const comment of inParentsFirstOrder(data.comments)) {
      const id = idByLegacy.get(comment.legacyObjectId);
      const pageId = pageIdByPath.get(comment.path);
      if (!id || !pageId) continue;

      const parentId = comment.legacyParentObjectId
        ? (idByLegacy.get(comment.legacyParentObjectId) ?? null)
        : null;

      await tx
        .insert(comments)
        .values({
          id,
          legacyObjectId: comment.legacyObjectId,
          pageId,
          parentId,
          // A top-level comment is its own root.
          rootId: rootOf(comment, idByLegacy, data.comments) ?? id,
          status: comment.status,
          bodyMarkdown: comment.bodyMarkdown,
          // Rendered on first read once the markdown pipeline lands (M3).
          bodyHtml: comment.bodyHtml,
          legacyMarkdownDerived: comment.legacyMarkdownDerived,
          authorUserId: comment.legacyAuthorObjectId
            ? (userIdByLegacy.get(comment.legacyAuthorObjectId) ?? null)
            : null,
          authorName: comment.authorName,
          authorEmail: comment.authorEmail,
          authorEmailHash: comment.authorEmailHash,
          authorUrl: comment.authorUrl,
          authorIp: comment.authorIp,
          userAgent: comment.userAgent,
          isSticky: comment.isSticky,
          likeCount: comment.likeCount,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        })
        .onConflictDoUpdate({
          target: comments.legacyObjectId,
          set: {
            status: comment.status,
            bodyMarkdown: comment.bodyMarkdown,
            isSticky: comment.isSticky,
            likeCount: comment.likeCount,
            updatedAt: comment.updatedAt,
          },
        });
    }

    // ── Reaction baselines ───────────────────────────────────────────────────
    const kinds = await tx
      .select({ key: reactionKinds.key, legacyIndex: reactionKinds.legacyIndex })
      .from(reactionKinds);
    const keyByLegacyIndex = new Map(
      kinds.filter((k) => k.legacyIndex !== null).map((k) => [k.legacyIndex, k.key]),
    );

    let baselineCount = 0;
    for (const reaction of data.reactions) {
      const pageId = pageIdByPath.get(reaction.path);
      const kindKey = keyByLegacyIndex.get(reaction.legacyIndex);
      if (!pageId || !kindKey) {
        throw new Error(
          `No reaction_kinds row maps to legacy index ${reaction.legacyIndex}; the seed migration is missing or incomplete.`,
        );
      }

      await tx
        .insert(reactionBaselines)
        .values({ pageId, kindKey, count: reaction.count })
        .onConflictDoUpdate({
          target: [reactionBaselines.pageId, reactionBaselines.kindKey],
          set: { count: reaction.count },
        });
      baselineCount += 1;
    }

    return {
      pages: pageIdByPath.size,
      users: userIdByLegacy.size,
      comments: data.comments.length,
      reactionBaselines: baselineCount,
    };
  });
}

/** Parents before children, so the self-referencing FK is never violated. */
function inParentsFirstOrder(rows: CommentRow[]): CommentRow[] {
  const byLegacyId = new Map(rows.map((r) => [r.legacyObjectId, r]));
  const depth = (row: CommentRow): number => {
    let d = 0;
    let current: CommentRow | undefined = row;
    const seen = new Set<string>();
    while (current?.legacyParentObjectId && !seen.has(current.legacyObjectId)) {
      seen.add(current.legacyObjectId);
      current = byLegacyId.get(current.legacyParentObjectId);
      d += 1;
    }
    return d;
  };
  return [...rows].sort((a, b) => depth(a) - depth(b));
}

function rootOf(
  comment: CommentRow,
  idByLegacy: Map<string, string>,
  all: CommentRow[],
): string | null {
  const byLegacyId = new Map(all.map((r) => [r.legacyObjectId, r]));
  let current: CommentRow = comment;
  const seen = new Set<string>([current.legacyObjectId]);

  while (current.legacyParentObjectId) {
    const parent = byLegacyId.get(current.legacyParentObjectId);
    if (!parent || seen.has(parent.legacyObjectId)) break;
    seen.add(parent.legacyObjectId);
    current = parent;
  }

  return idByLegacy.get(current.legacyObjectId) ?? null;
}

/** Wipes migrated data so a rehearsal can be repeated from a clean slate. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table comments, reactions, reaction_baselines, pages, users, moderation_log, notification_outbox, sessions, user_verifications restart identity cascade`,
  );
}

export async function countRow(db: Db, table: string): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
