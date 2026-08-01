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
