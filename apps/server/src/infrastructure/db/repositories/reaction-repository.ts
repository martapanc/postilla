import { and, eq, sql } from 'drizzle-orm';
import {
  notificationOutbox,
  pages,
  reactionBaselines,
  reactionKinds,
  reactions,
} from '../schema.js';
import type { ReactionRepository } from '../../../ports/repositories.js';
import type { Database } from '../client.js';

/**
 * Reaction writes.
 *
 * A page's total is `baseline + count(reactions)`: the baseline holds counts
 * migrated from LeanCloud, which arrived as totals with no rows behind them,
 * and everything since is a real row.
 */
export function createReactionRepository(db: Database): ReactionRepository {
  async function totalsFor(pageId: string, kindKey: string) {
    const [row] = await db
      .select({
        kindTotal: sql<number>`(
          coalesce((select count(*) from ${reactions}
                    where ${reactions.pageId} = ${pageId} and ${reactions.kindKey} = ${kindKey}), 0)
          + coalesce((select count from ${reactionBaselines}
                      where ${reactionBaselines.pageId} = ${pageId} and ${reactionBaselines.kindKey} = ${kindKey}), 0)
        )::int`,
        pageTotal: sql<number>`(
          coalesce((select count(*) from ${reactions} where ${reactions.pageId} = ${pageId}), 0)
          + coalesce((select sum(count) from ${reactionBaselines} where ${reactionBaselines.pageId} = ${pageId}), 0)
        )::int`,
      })
      .from(sql`(select 1) as _`);

    return { kindTotal: Number(row?.kindTotal ?? 0), pageTotal: Number(row?.pageTotal ?? 0) };
  }

  return {
    async findKind(key: string) {
      const row = await db.query.reactionKinds.findFirst({
        where: eq(reactionKinds.key, key),
        columns: { key: true, emoji: true },
      });
      return row ?? null;
    },

    async ensurePage(path: string): Promise<string> {
      const [row] = await db
        .insert(pages)
        .values({ path })
        .onConflictDoUpdate({ target: pages.path, set: { updatedAt: new Date() } })
        .returning({ id: pages.id });
      return row!.id;
    },

    async addReaction({ pageId, kindKey, visitorHash }) {
      // `DO NOTHING` plus a returning clause tells us whether this was new:
      // an empty result means the visitor had already reacted.
      const inserted = await db
        .insert(reactions)
        .values({ pageId, kindKey, visitorHash })
        .onConflictDoNothing()
        .returning({ id: reactions.id });

      return { added: inserted.length > 0, ...(await totalsFor(pageId, kindKey)) };
    },

    async removeReaction({ pageId, kindKey, visitorHash }) {
      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.pageId, pageId),
            eq(reactions.kindKey, kindKey),
            eq(reactions.visitorHash, visitorHash),
          ),
        );

      return { added: false, ...(await totalsFor(pageId, kindKey)) };
    },

    async queueReactionNotification({ dedupeKey, event }) {
      // The partial unique index covers undelivered rows only, so a burst
      // inside one window collapses to a single row — and the payload is
      // overwritten, so the message that goes out carries the final counts
      // rather than the first.
      await db
        .insert(notificationOutbox)
        .values({ eventType: event.type, payload: event, dedupeKey })
        .onConflictDoUpdate({
          target: notificationOutbox.dedupeKey,
          // The index is partial, so the conflict target has to repeat its
          // predicate — without this Postgres cannot match an arbiter index
          // and rejects the statement outright.
          targetWhere: sql`${notificationOutbox.deliveredAt} is null`,
          set: { payload: event },
        });
    },
  };
}
