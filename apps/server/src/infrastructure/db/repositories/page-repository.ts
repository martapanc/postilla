import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { comments, pages, reactionBaselines, reactionKinds, reactions } from '../schema.js';
import type { PageRepository, PageStatsRecord } from '../../../ports/repositories.js';
import type { Database } from '../client.js';

/**
 * A page's reaction total is `baseline + count(reactions)`: the baseline holds
 * counts migrated from LeanCloud, which arrived as totals with no individual
 * events behind them, while everything since is a real row in `reactions`.
 */
export function createPageRepository(db: Database): PageRepository {
  return {
    async getStats(paths: string[]): Promise<PageStatsRecord[]> {
      if (paths.length === 0) return [];

      const kinds = await db
        .select({
          key: reactionKinds.key,
          emoji: reactionKinds.emoji,
          sortOrder: reactionKinds.sortOrder,
        })
        .from(reactionKinds)
        .orderBy(reactionKinds.sortOrder);

      const pageRows = await db
        .select({ id: pages.id, path: pages.path, pageviews: pages.pageviews })
        .from(pages)
        .where(inArray(pages.path, paths));

      const pageIds = pageRows.map((p) => p.id);

      const commentCounts = new Map<string, number>();
      const reactionTotals = new Map<string, number>();

      if (pageIds.length > 0) {
        const counted = await db
          .select({ pageId: comments.pageId, total: count() })
          .from(comments)
          .where(and(inArray(comments.pageId, pageIds), eq(comments.status, 'approved')))
          .groupBy(comments.pageId);
        for (const row of counted) commentCounts.set(row.pageId, Number(row.total));

        const baselines = await db
          .select({
            pageId: reactionBaselines.pageId,
            kindKey: reactionBaselines.kindKey,
            total: reactionBaselines.count,
          })
          .from(reactionBaselines)
          .where(inArray(reactionBaselines.pageId, pageIds));
        for (const row of baselines) {
          reactionTotals.set(`${row.pageId}:${row.kindKey}`, Number(row.total));
        }

        const events = await db
          .select({
            pageId: reactions.pageId,
            kindKey: reactions.kindKey,
            total: sql<number>`count(*)::int`,
          })
          .from(reactions)
          .where(inArray(reactions.pageId, pageIds))
          .groupBy(reactions.pageId, reactions.kindKey);
        for (const row of events) {
          const key = `${row.pageId}:${row.kindKey}`;
          reactionTotals.set(key, (reactionTotals.get(key) ?? 0) + Number(row.total));
        }
      }

      const byPath = new Map(pageRows.map((p) => [p.path, p]));

      // Answer for every requested path, including ones with no row yet, so
      // the widget renders identically on a brand-new post.
      return paths.map((path) => {
        const page = byPath.get(path);
        return {
          path,
          pageviews: page ? Number(page.pageviews) : 0,
          commentCount: page ? (commentCounts.get(page.id) ?? 0) : 0,
          reactions: kinds.map((kind) => ({
            key: kind.key,
            emoji: kind.emoji,
            sortOrder: kind.sortOrder,
            count: page ? (reactionTotals.get(`${page.id}:${kind.key}`) ?? 0) : 0,
          })),
        };
      });
    },

    async incrementPageview(path: string): Promise<number> {
      // Upsert so the first view of a page creates it; the increment happens
      // inside Postgres, so concurrent views cannot lose each other the way a
      // read-modify-write would.
      const [row] = await db
        .insert(pages)
        .values({ path, pageviews: 1 })
        .onConflictDoUpdate({
          target: pages.path,
          set: { pageviews: sql`${pages.pageviews} + 1`, updatedAt: new Date() },
        })
        .returning({ pageviews: pages.pageviews });

      return Number(row?.pageviews ?? 0);
    },
  };
}
