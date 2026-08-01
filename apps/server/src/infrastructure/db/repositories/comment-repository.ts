import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { comments, pages, users } from '../schema.js';
import type { CommentRepository, ThreadPage } from '../../../ports/repositories.js';
import type { Database } from '../client.js';

/**
 * Drizzle-backed reads.
 *
 * The tricky requirement is that pagination applies to *root* comments while
 * the response must still carry every reply belonging to those roots — so a
 * thread is never cut in half by a page boundary. That is done in two
 * statements: select the ids of the roots on this page, then fetch those roots
 * and their descendants in one go.
 */
export function createCommentRepository(db: Database): CommentRepository {
  return {
    async listApprovedThreads({ path, sort, page, pageSize }): Promise<ThreadPage> {
      const pageRow = await db.query.pages.findFirst({
        where: eq(pages.path, path),
        columns: { id: true },
      });

      if (!pageRow) {
        return { comments: [], totalRoots: 0, totalComments: 0 };
      }

      const approvedOnPage = and(eq(comments.pageId, pageRow.id), eq(comments.status, 'approved'));
      const isRoot = sql`${comments.parentId} is null`;

      const [totals] = await db
        .select({
          totalComments: count(),
          totalRoots: sql<number>`count(*) filter (where ${comments.parentId} is null)::int`,
        })
        .from(comments)
        .where(approvedOnPage);

      // Sticky first in every ordering: a pinned comment that sorts to page 4
      // is not pinned to anything.
      const ordering = {
        latest: [desc(comments.isSticky), desc(comments.createdAt)],
        oldest: [desc(comments.isSticky), asc(comments.createdAt)],
        hottest: [desc(comments.isSticky), desc(comments.likeCount), desc(comments.createdAt)],
      }[sort];

      const rootIds = await db
        .select({ id: comments.id })
        .from(comments)
        .where(and(approvedOnPage, isRoot))
        .orderBy(...ordering)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      if (rootIds.length === 0) {
        return {
          comments: [],
          totalRoots: totals?.totalRoots ?? 0,
          totalComments: totals?.totalComments ?? 0,
        };
      }

      const rows = await db
        .select({
          id: comments.id,
          parentId: comments.parentId,
          rootId: comments.rootId,
          authorName: comments.authorName,
          authorUrl: comments.authorUrl,
          bodyHtml: comments.bodyHtml,
          bodyMarkdown: comments.bodyMarkdown,
          createdAt: comments.createdAt,
          isSticky: comments.isSticky,
          likeCount: comments.likeCount,
          registeredAvatarUrl: users.avatarUrl,
          authorRole: users.role,
        })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorUserId))
        .where(
          and(
            approvedOnPage,
            inArray(
              comments.rootId,
              rootIds.map((r) => r.id),
            ),
          ),
        );

      return {
        comments: rows.map((row) => ({
          id: row.id,
          parentId: row.parentId,
          rootId: row.rootId,
          authorName: row.authorName,
          authorUrl: row.authorUrl,
          authorAvatarUrl: row.registeredAvatarUrl,
          authorIsAdmin: row.authorRole === 'admin',
          bodyHtml: row.bodyHtml,
          bodyMarkdown: row.bodyMarkdown,
          createdAt: row.createdAt,
          isSticky: row.isSticky,
          likeCount: row.likeCount,
        })),
        totalRoots: totals?.totalRoots ?? 0,
        totalComments: totals?.totalComments ?? 0,
      };
    },

    async countApprovedByPaths(paths: string[]): Promise<Map<string, number>> {
      if (paths.length === 0) return new Map();

      const rows = await db
        .select({ path: pages.path, total: count(comments.id) })
        .from(pages)
        .leftJoin(comments, and(eq(comments.pageId, pages.id), eq(comments.status, 'approved')))
        .where(inArray(pages.path, paths))
        .groupBy(pages.path);

      const counts = new Map<string, number>(rows.map((r) => [r.path, Number(r.total)]));
      // A path nobody has commented on is 0, not missing — the caller asked
      // about it and deserves an answer.
      for (const path of paths) if (!counts.has(path)) counts.set(path, 0);
      return counts;
    },
  };
}
