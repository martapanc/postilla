import type { ThreadSort } from '../domain/comment/thread.js';
import type { CommentCreatedEvent, ReactionAddedEvent } from '../domain/notifications/events.js';

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

  /** The parent a reply is attached to, or null if it does not exist. */
  findById(
    id: string,
  ): Promise<{ id: string; rootId: string; pageId: string; authorName: string } | null>;

  /** Drives the auditFirstOnly policy. */
  hasApprovedCommentFrom(authorEmailHash: string): Promise<boolean>;

  /** Recent activity for the same author, for rate limiting and duplicates. */
  recentActivityFor(input: {
    authorEmailHash: string | null;
    authorIp: string | null;
    since: Date;
  }): Promise<{ timestamps: Date[]; recentBodies: string[] }>;

  /**
   * Writes the comment and its notification outbox row in one transaction, so
   * a comment can never be stored without its notification being queued, nor
   * a notification queued for a comment that was not stored.
   */
  createWithOutbox(input: NewCommentInput): Promise<{ id: string; status: CommentStatus }>;

  /** Re-renders stored markdown into `body_html`. Used to backfill migrations. */
  backfillHtml(render: (markdown: string) => string): Promise<number>;
}

export type CommentStatus = 'approved' | 'pending' | 'spam';

export interface NewCommentInput {
  path: string;
  parentId: string | null;
  status: CommentStatus;
  bodyMarkdown: string;
  bodyHtml: string;
  authorName: string;
  authorEmail: string | null;
  authorEmailHash: string | null;
  authorUrl: string | null;
  authorIp: string | null;
  userAgent: string | null;
  authorUserId: string | null;
  locale: string;
  moderationReason: string;
  /**
   * Omitted when the comment is spam — nobody wants to be notified of that.
   * `commentId` is filled in by the repository, which is what generates it.
   */
  notify: Omit<CommentCreatedEvent, 'commentId'> | null;
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

export interface ReactionTotals {
  /** Whether a new reaction row was actually created. */
  added: boolean;
  kindTotal: number;
  pageTotal: number;
}

export interface ReactionRepository {
  findKind(key: string): Promise<{ key: string; emoji: string } | null>;
  ensurePage(path: string): Promise<string>;
  addReaction(input: {
    pageId: string;
    kindKey: string;
    visitorHash: string;
  }): Promise<ReactionTotals>;
  removeReaction(input: {
    pageId: string;
    kindKey: string;
    visitorHash: string;
  }): Promise<ReactionTotals>;
  /** Upserts on the dedupe key, so a burst coalesces into one message. */
  queueReactionNotification(input: { dedupeKey: string; event: ReactionAddedEvent }): Promise<void>;
}
