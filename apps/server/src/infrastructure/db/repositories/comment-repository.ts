import { and, asc, count, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { comments, moderationLog, notificationOutbox, pages, users } from '../schema.js';
import type {
  CommentRepository,
  NewCommentInput,
  ThreadPage,
} from '../../../ports/repositories.js';
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

    async findById(id: string) {
      const row = await db.query.comments.findFirst({
        where: eq(comments.id, id),
        columns: { id: true, rootId: true, pageId: true, authorName: true },
      });
      return row ?? null;
    },

    async hasApprovedCommentFrom(authorEmailHash: string): Promise<boolean> {
      // An indexed EXISTS on the partial index, not a count: we only need to
      // know whether there is at least one.
      const row = await db.query.comments.findFirst({
        where: and(eq(comments.authorEmailHash, authorEmailHash), eq(comments.status, 'approved')),
        columns: { id: true },
      });
      return row !== undefined;
    },

    async recentActivityFor({ authorEmailHash, authorIp, since }) {
      // Matched on email *or* IP: an author changing their email between
      // submissions should not reset their rate limit.
      const identity = [
        authorEmailHash ? eq(comments.authorEmailHash, authorEmailHash) : undefined,
        authorIp ? eq(comments.authorIp, authorIp) : undefined,
      ].filter((x) => x !== undefined);

      if (identity.length === 0) return { timestamps: [], recentBodies: [] };

      const rows = await db
        .select({ createdAt: comments.createdAt, bodyMarkdown: comments.bodyMarkdown })
        .from(comments)
        .where(and(gte(comments.createdAt, since), or(...identity)))
        .orderBy(desc(comments.createdAt))
        .limit(50);

      return {
        timestamps: rows.map((r) => r.createdAt),
        recentBodies: rows.map((r) => r.bodyMarkdown),
      };
    },

    async createWithOutbox(input: NewCommentInput) {
      return db.transaction(async (tx) => {
        const [page] = await tx
          .insert(pages)
          .values({ path: input.path })
          .onConflictDoUpdate({ target: pages.path, set: { updatedAt: new Date() } })
          .returning({ id: pages.id });

        const parent = input.parentId
          ? await tx.query.comments.findFirst({
              where: eq(comments.id, input.parentId),
              columns: { id: true, rootId: true },
            })
          : undefined;

        const id = crypto.randomUUID();

        const [row] = await tx
          .insert(comments)
          .values({
            id,
            pageId: page!.id,
            parentId: parent?.id ?? null,
            // Materialized once, here, inside the same transaction: a
            // top-level comment roots itself, a reply inherits its parent's.
            rootId: parent?.rootId ?? id,
            status: input.status,
            bodyMarkdown: input.bodyMarkdown,
            bodyHtml: input.bodyHtml,
            authorName: input.authorName,
            authorEmail: input.authorEmail,
            authorEmailHash: input.authorEmailHash,
            authorUrl: input.authorUrl,
            authorIp: input.authorIp,
            userAgent: input.userAgent,
            authorUserId: input.authorUserId,
            locale: input.locale,
          })
          .returning({ id: comments.id, status: comments.status });

        await tx.insert(moderationLog).values({
          commentId: id,
          fromStatus: null,
          toStatus: input.status,
          reason: input.moderationReason,
        });

        if (input.notify) {
          // The event is completed here because this is where the id exists.
          await tx.insert(notificationOutbox).values({
            eventType: input.notify.type,
            payload: { ...input.notify, commentId: id },
          });
        }

        // `input.status`, not the column: the database enum also carries
        // 'deleted', which is not a status a comment can be created with.
        return { id: row!.id, status: input.status };
      });
    },

    async backfillHtml(render: (markdown: string) => string): Promise<number> {
      const rows = await db
        .select({ id: comments.id, bodyMarkdown: comments.bodyMarkdown })
        .from(comments)
        .where(and(isNotNull(comments.legacyObjectId), eq(comments.bodyHtml, '')));

      for (const row of rows) {
        await db
          .update(comments)
          .set({ bodyHtml: render(row.bodyMarkdown) })
          .where(eq(comments.id, row.id));
      }

      return rows.length;
    },
  };
}
