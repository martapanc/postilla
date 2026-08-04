import { z } from 'zod';
import { localeCode, pagePath, paginationMeta, paginationQuery } from './common.js';

/**
 * The public shape of a comment.
 *
 * Note what is absent: author email, email hash, IP address, and user agent.
 * Those are stored but never leave the server on a public endpoint. Because
 * Fastify serializes responses *from this schema*, adding a field to the
 * database cannot leak it — it has to be added here deliberately.
 */
export const publicComment = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  authorName: z.string(),
  authorUrl: z.url().nullable(),
  authorAvatarUrl: z.url().nullable(),
  /** True when the author is a registered admin, so the UI can badge them. */
  authorIsAdmin: z.boolean(),
  bodyHtml: z.string(),
  createdAt: z.iso.datetime(),
  isSticky: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  /** Set only when the reply's parent is not the thread root. */
  replyToName: z.string().nullable(),
});

export const commentThread = z.object({
  root: publicComment,
  /** Always oldest-first: a conversation read backwards is incoherent. */
  replies: z.array(publicComment),
});

export const commentSort = z.enum(['latest', 'oldest', 'hottest']).default('latest');

export const listCommentsQuery = z
  .object({
    path: pagePath,
    sort: commentSort,
  })
  .extend(paginationQuery.shape);

export const listCommentsResponse = z.object({
  threads: z.array(commentThread),
  pagination: paginationMeta,
  /** Every comment on the page, replies included — what the UI displays as a count. */
  totalComments: z.number().int().nonnegative(),
});

/** Comment counts for several pages at once, for index and archive listings. */
export const commentCountQuery = z.object({
  paths: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .pipe(z.array(pagePath).min(1).max(100)),
});

export const commentCountResponse = z.object({
  counts: z.array(z.object({ path: z.string(), count: z.number().int().nonnegative() })),
});

/**
 * A new comment, as the widget submits it.
 *
 * Email is optional but, when given, is what enables reply notifications, a
 * gravatar, and the auditFirstOnly policy. It is stored and never returned.
 */
export const createCommentBody = z.object({
  path: pagePath,
  parentId: z.uuid().nullish(),
  comment: z.string().min(1).max(20_000),
  nick: z.string().min(1).max(200),
  mail: z.email().max(320).nullish(),
  link: z.url().max(2048).nullish(),
  /** Cloudflare Turnstile token; required only when a captcha is configured. */
  captchaToken: z.string().max(4096).nullish(),
  locale: localeCode.optional(),
});

export const createCommentResponse = z.object({
  id: z.uuid(),
  /**
   * `pending` means the comment was accepted but is awaiting moderation, so
   * the widget can say so rather than appearing to lose it.
   */
  status: z.enum(['approved', 'pending']),
});

export type CreateCommentBody = z.infer<typeof createCommentBody>;
export type CreateCommentResponse = z.infer<typeof createCommentResponse>;

export type PublicComment = z.infer<typeof publicComment>;
export type CommentThread = z.infer<typeof commentThread>;
export type CommentSort = z.infer<typeof commentSort>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuery>;
export type ListCommentsResponse = z.infer<typeof listCommentsResponse>;
export type CommentCountResponse = z.infer<typeof commentCountResponse>;
