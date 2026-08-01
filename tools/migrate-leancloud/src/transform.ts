import { createHash } from 'node:crypto';
import type { LeanComment, LeanCounter, LeanUser } from './records.js';
import { SOCIAL_FIELDS } from './records.js';

/**
 * Pure transformation: LeanCloud records in, rows for the new schema out.
 * No database, no network, no clock — so every rule here is unit-testable and
 * the migration can be rehearsed as often as we like.
 */

export interface Rejection {
  class: 'Comment' | 'Counter' | 'Users';
  objectId: string;
  reason: string;
}

export interface Note {
  kind: string;
  detail: string;
}

/**
 * Canonical page path. LeanCloud stores the path a visitor's browser reported,
 * so two spellings of one page would otherwise become two rows and split the
 * comment thread.
 */
export function normalizePath(raw: string): string {
  let path = raw.trim();

  // Tolerate absolute URLs; we only ever key on the path.
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* fall through and treat it as a path */
    }
  }

  path = path.split('#')[0] ?? path;
  path = path.split('?')[0] ?? path;
  path = path.toLowerCase();
  if (!path.startsWith('/')) path = `/${path}`;
  // Collapse duplicate slashes, then drop a trailing one (but keep the root).
  path = path.replaceAll(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');

  return path;
}

/** Stable pseudonymous key for a commenter: gravatar, and the audit policy. */
export function hashEmail(email: string | null): string | null {
  if (!email) return null;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function mapStatus(leanStatus: LeanComment['status']): 'approved' | 'pending' | 'spam' {
  switch (leanStatus) {
    case 'approved':
      return 'approved';
    case 'waiting':
      return 'pending';
    case 'spam':
      return 'spam';
  }
}

/**
 * Splits Waline's overloaded `type` column. It encodes a role, and sometimes
 * an in-flight email verification as `verify:<code>:<expiry>`.
 */
export function parseUserType(type: string): {
  role: 'admin' | 'moderator';
  emailVerified: boolean;
  pendingVerification: { code: string; expiresAt: Date } | null;
} {
  if (type === 'administrator') {
    return { role: 'admin', emailVerified: true, pendingVerification: null };
  }

  if (type.startsWith('verify:')) {
    const [, code, expiry] = type.split(':');
    const expiresAt = expiry ? new Date(Number(expiry)) : null;
    return {
      role: 'moderator',
      emailVerified: false,
      pendingVerification:
        code && expiresAt && !Number.isNaN(expiresAt.getTime()) ? { code, expiresAt } : null,
    };
  }

  return { role: 'moderator', emailVerified: true, pendingVerification: null };
}

export interface PageRow {
  path: string;
  pageviews: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pages come from two sources — Counter rows and the URLs comments were left
 * on — which must agree on one row per path.
 */
export function buildPages(
  counters: LeanCounter[],
  comments: LeanComment[],
): { pages: Map<string, PageRow>; notes: Note[] } {
  const pages = new Map<string, PageRow>();
  const notes: Note[] = [];
  const seenRawByPath = new Map<string, Set<string>>();

  const record = (raw: string): string => {
    const path = normalizePath(raw);
    const seen = seenRawByPath.get(path) ?? new Set<string>();
    seen.add(raw);
    seenRawByPath.set(path, seen);
    return path;
  };

  for (const counter of counters) {
    const path = record(counter.url);
    const existing = pages.get(path);

    if (existing) {
      // Two Counter rows normalizing to one page: sum the views rather than
      // letting the last one win, or traffic silently disappears.
      existing.pageviews += counter.time;
      if (counter.createdAt < existing.createdAt) existing.createdAt = counter.createdAt;
      if (counter.updatedAt > existing.updatedAt) existing.updatedAt = counter.updatedAt;
      notes.push({
        kind: 'counter_merged',
        detail: `two Counter rows map to ${path}; pageviews summed to ${existing.pageviews}`,
      });
      continue;
    }

    pages.set(path, {
      path,
      pageviews: counter.time,
      createdAt: counter.createdAt,
      updatedAt: counter.updatedAt,
    });
  }

  // A page can have comments but no Counter row if it was never viewed with
  // the pageview script active.
  for (const comment of comments) {
    const path = record(comment.url);
    if (pages.has(path)) continue;

    pages.set(path, {
      path,
      pageviews: 0,
      createdAt: comment.insertedAt,
      updatedAt: comment.updatedAt,
    });
    notes.push({ kind: 'page_from_comment', detail: `${path} had comments but no Counter row` });
  }

  for (const [path, raws] of seenRawByPath) {
    if (raws.size > 1) {
      notes.push({
        kind: 'path_normalization_merge',
        detail: `${raws.size} distinct URLs collapsed to ${path}: ${[...raws].join(', ')}`,
      });
    }
  }

  return { pages, notes };
}

export interface CommentRow {
  legacyObjectId: string;
  path: string;
  legacyParentObjectId: string | null;
  status: 'approved' | 'pending' | 'spam';
  bodyMarkdown: string;
  bodyHtml: string;
  legacyMarkdownDerived: boolean;
  legacyAuthorObjectId: string | null;
  authorName: string;
  authorEmail: string | null;
  authorEmailHash: string | null;
  authorUrl: string | null;
  authorIp: string | null;
  userAgent: string | null;
  isSticky: boolean;
  likeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `rid` is not trusted. Waline maintains it as a denormalized root pointer,
 * and a single bad write leaves a thread pointing at the wrong ancestor
 * forever. The root is recomputed by walking `pid`, which is the field the UI
 * actually depends on.
 */
export function resolveRoot(
  objectId: string,
  byId: Map<string, LeanComment>,
): { rootId: string; depth: number } | { cycle: true } {
  const seen = new Set<string>([objectId]);
  let current = byId.get(objectId);
  let depth = 0;

  while (current?.pid) {
    if (seen.has(current.pid)) return { cycle: true };
    const parent = byId.get(current.pid);
    if (!parent) break; // Orphan; reported separately by the caller.
    seen.add(parent.objectId);
    current = parent;
    depth += 1;
  }

  return { rootId: current?.objectId ?? objectId, depth };
}

export function transformComments(comments: LeanComment[]): {
  rows: CommentRow[];
  rejections: Rejection[];
  notes: Note[];
} {
  const byId = new Map(comments.map((c) => [c.objectId, c]));
  const rows: CommentRow[] = [];
  const rejections: Rejection[] = [];
  const notes: Note[] = [];

  let maxDepth = 0;
  let ridDisagreements = 0;

  for (const comment of comments) {
    if (comment.pid && !byId.has(comment.pid)) {
      rejections.push({
        class: 'Comment',
        objectId: comment.objectId,
        reason: `parent ${comment.pid} does not exist in the export`,
      });
      continue;
    }

    const root = resolveRoot(comment.objectId, byId);
    if ('cycle' in root) {
      rejections.push({
        class: 'Comment',
        objectId: comment.objectId,
        reason: 'reply chain forms a cycle',
      });
      continue;
    }

    maxDepth = Math.max(maxDepth, root.depth);
    if (comment.rid && comment.rid !== root.rootId) ridDisagreements += 1;

    rows.push({
      legacyObjectId: comment.objectId,
      path: normalizePath(comment.url),
      legacyParentObjectId: comment.pid ?? null,
      status: mapStatus(comment.status),
      // The export stores authored source, not rendered HTML. `bodyHtml` is a
      // cache and is regenerated by the server on first read.
      bodyMarkdown: comment.comment,
      bodyHtml: '',
      legacyMarkdownDerived: false,
      legacyAuthorObjectId: comment.user_id ?? null,
      authorName: comment.nick,
      authorEmail: comment.mail,
      authorEmailHash: hashEmail(comment.mail),
      authorUrl: comment.link,
      authorIp: comment.ip,
      userAgent: comment.ua,
      isSticky: comment.sticky ?? false,
      likeCount: comment.like ?? 0,
      createdAt: comment.insertedAt,
      updatedAt: comment.updatedAt,
    });
  }

  notes.push({ kind: 'max_thread_depth', detail: String(maxDepth) });
  if (ridDisagreements > 0) {
    notes.push({
      kind: 'rid_disagreement',
      detail: `${ridDisagreements} comment(s) had a stored rid that disagreed with the recomputed root; the recomputed value was used`,
    });
  }

  return { rows, rejections, notes };
}

export interface BaselineRow {
  path: string;
  legacyIndex: number;
  count: number;
}

/** Turns the positional reaction0..8 columns into rows. Zeroes are skipped. */
export function transformReactions(counters: LeanCounter[]): {
  rows: BaselineRow[];
  notes: Note[];
} {
  const totals = new Map<string, number>();
  const notes: Note[] = [];

  for (const counter of counters) {
    const path = normalizePath(counter.url);
    for (let i = 0; i <= 8; i += 1) {
      const count = counter[`reaction${i}` as keyof LeanCounter] as number | null | undefined;
      if (typeof count !== 'number' || count <= 0) continue;
      const key = `${path} ${i}`;
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }

  const rows = [...totals.entries()].map(([key, count]) => {
    const [path = '', index = '0'] = key.split(' ');
    return { path, legacyIndex: Number(index), count };
  });

  const grand = rows.reduce((sum, r) => sum + r.count, 0);
  notes.push({
    kind: 'reactions_migrated',
    detail: `${grand} across ${rows.length} page/kind pairs`,
  });

  return { rows, notes };
}

export interface UserRow {
  legacyObjectId: string;
  email: string;
  displayName: string;
  role: 'admin' | 'moderator';
  passwordHash: string;
  passwordAlgo: 'phpass';
  totpSecret: string | null;
  totpEnabledAt: Date | null;
  avatarUrl: string | null;
  websiteUrl: string | null;
  label: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function transformUsers(users: LeanUser[]): { rows: UserRow[]; notes: Note[] } {
  const notes: Note[] = [];

  const rows = users.map((user) => {
    const { role, emailVerified, pendingVerification } = parseUserType(user.type);

    if (pendingVerification) {
      notes.push({
        kind: 'pending_verification_dropped',
        detail: `${user.objectId} had an in-flight email verification; it is stale and was not carried over`,
      });
    }

    const linked = SOCIAL_FIELDS.filter((f) => user[f]);
    if (linked.length > 0) {
      // Social login is not carried forward (see docs/adr/0003), so anything
      // discarded has to be visible rather than silent.
      notes.push({
        kind: 'social_identity_dropped',
        detail: `${user.objectId} had linked accounts discarded: ${linked.join(', ')}`,
      });
    }

    const totpSecret = user['2fa'];

    return {
      legacyObjectId: user.objectId,
      email: user.email.trim().toLowerCase(),
      displayName: user.display_name,
      role,
      passwordHash: user.password,
      passwordAlgo: 'phpass' as const,
      totpSecret,
      // The original schema records no enablement time; the account's own
      // creation is the closest true statement available.
      totpEnabledAt: totpSecret ? user.createdAt : null,
      avatarUrl: user.avatar,
      websiteUrl: user.url,
      label: user.label,
      emailVerifiedAt: emailVerified ? user.createdAt : null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  });

  return { rows, notes };
}
