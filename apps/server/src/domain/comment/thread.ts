/**
 * Assembles a flat list of comment rows into the two-level thread the widget
 * renders. Pure: the repository decides *which* comments to fetch, this
 * decides how they relate.
 */

export interface ThreadableComment {
  id: string;
  parentId: string | null;
  rootId: string;
  createdAt: Date;
  isSticky: boolean;
}

export interface Thread<T extends ThreadableComment> {
  root: T;
  replies: T[];
}

export type ThreadSort = 'latest' | 'oldest' | 'hottest';

/**
 * Groups replies under their root and orders both levels.
 *
 * Replies are always oldest-first regardless of the chosen sort: a
 * conversation read newest-first is incoherent. Only the roots reorder.
 *
 * Sticky roots float to the top, keeping their relative order.
 */
export function buildThreads<T extends ThreadableComment>(
  comments: T[],
  sort: ThreadSort,
  score: (comment: T) => number = () => 0,
): Thread<T>[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots: T[] = [];
  const repliesByRoot = new Map<string, T[]>();

  for (const comment of comments) {
    // A reply whose root is absent from this page of results is promoted to a
    // root rather than dropped — losing a comment is worse than flattening one.
    const isRoot = comment.parentId === null || !byId.has(comment.rootId);

    if (isRoot) {
      roots.push(comment);
      continue;
    }

    const siblings = repliesByRoot.get(comment.rootId) ?? [];
    siblings.push(comment);
    repliesByRoot.set(comment.rootId, siblings);
  }

  const byTime = (a: T, b: T, dir: 1 | -1): number =>
    (a.createdAt.getTime() - b.createdAt.getTime()) * dir;

  const sortRoots = (a: T, b: T): number => {
    if (a.isSticky !== b.isSticky) return a.isSticky ? -1 : 1;
    switch (sort) {
      case 'latest':
        return byTime(a, b, -1);
      case 'oldest':
        return byTime(a, b, 1);
      case 'hottest': {
        const diff = score(b) - score(a);
        // Ties fall back to recency so ordering is deterministic, which is
        // what keeps pagination from repeating or skipping rows.
        return diff !== 0 ? diff : byTime(a, b, -1);
      }
    }
  };

  return roots.sort(sortRoots).map((root) => ({
    root,
    replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) => byTime(a, b, 1)),
  }));
}
