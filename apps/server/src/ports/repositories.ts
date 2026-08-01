import type { ThreadSort } from '../domain/comment/thread.js';

/**
 * What the application needs from persistence, expressed without reference to
 * how it is stored. Use cases depend on these interfaces; the Drizzle
 * implementations live in infrastructure and are supplied by the composition
 * root, which is what lets a use case be tested with an in-memory fake.
 */

export interface CommentRecord {
  id: string;
  parentId: string | null;
  rootId: string;
  authorName: string;
  authorUrl: string | null;
  authorAvatarUrl: string | null;
  authorIsAdmin: boolean;
  bodyHtml: string;
  bodyMarkdown: string;
  createdAt: Date;
  isSticky: boolean;
  likeCount: number;
}

export interface ThreadPage {
  comments: CommentRecord[];
  /** Root comments matching the filter, ignoring pagination. */
  totalRoots: number;
  /** Every approved comment on the page, replies included. */
  totalComments: number;
}

export interface CommentRepository {
  /**
   * Returns a page of root comments together with all of their replies.
   * Pagination applies to roots only — a thread is never split across pages.
   */
  listApprovedThreads(input: {
    path: string;
    sort: ThreadSort;
    page: number;
    pageSize: number;
  }): Promise<ThreadPage>;

  countApprovedByPaths(paths: string[]): Promise<Map<string, number>>;
}

export interface PageStatsRecord {
  path: string;
  pageviews: number;
  commentCount: number;
  reactions: { key: string; emoji: string; count: number; sortOrder: number }[];
}

export interface PageRepository {
  /** Stats for known paths. Unknown paths are returned as zeroed rows. */
  getStats(paths: string[]): Promise<PageStatsRecord[]>;

  /** Increments and returns the new total, creating the page if needed. */
  incrementPageview(path: string): Promise<number>;
}
