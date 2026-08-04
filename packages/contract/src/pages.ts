import { z } from 'zod';
import { pagePath } from './common.js';

export const reactionCount = z.object({
  key: z.string(),
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  sortOrder: z.number().int(),
});

export const pageStats = z.object({
  path: z.string(),
  pageviews: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  /** Every configured reaction, including those at zero, so the UI is stable. */
  reactions: z.array(reactionCount),
});

export const pageStatsQuery = z.object({
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

export const pageStatsResponse = z.object({
  pages: z.array(pageStats),
});

export const recordPageviewBody = z.object({
  path: pagePath,
});

export const recordPageviewResponse = z.object({
  path: z.string(),
  pageviews: z.number().int().nonnegative(),
});

export type ReactionCount = z.infer<typeof reactionCount>;
export type PageStats = z.infer<typeof pageStats>;
export type PageStatsResponse = z.infer<typeof pageStatsResponse>;
export type RecordPageviewResponse = z.infer<typeof recordPageviewResponse>;

export const recordReactionBody = z.object({
  path: pagePath,
  /** A key from the reaction registry, e.g. "heart". */
  kind: z.string().min(1).max(50),
  /** Toggle an existing reaction off. */
  remove: z.boolean().default(false),
});

export const recordReactionResponse = z.object({
  kind: z.string(),
  kindTotal: z.number().int().nonnegative(),
  pageTotal: z.number().int().nonnegative(),
  /** Whether this visitor's reaction is now recorded. */
  active: z.boolean(),
});

export type RecordReactionResponse = z.infer<typeof recordReactionResponse>;
