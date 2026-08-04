/**
 * Rules about *whether* a comment may be submitted at all — as opposed to
 * whether it gets published, which is the moderation policy's job.
 *
 * All pure. The caller supplies the current time and whatever recent history
 * it has gathered, so every branch here is testable without a clock or a
 * database.
 */

export interface SubmissionLimits {
  /** Minimum gap between two comments from the same author. */
  minIntervalSeconds: number;
  /** Cap on comments from one author within the rolling window. */
  maxPerWindow: number;
  windowSeconds: number;
  maxBodyLength: number;
  maxNameLength: number;
}

export interface RecentActivity {
  /** Timestamps of this author's recent comments, newest first. */
  timestamps: Date[];
  /** Bodies of this author's recent comments, for duplicate detection. */
  recentBodies: string[];
}

export type SubmissionRejection =
  | { kind: 'too_fast'; retryAfterSeconds: number }
  | { kind: 'too_many'; retryAfterSeconds: number }
  | { kind: 'duplicate' }
  | { kind: 'body_empty' }
  | { kind: 'body_too_long'; max: number }
  | { kind: 'name_too_long'; max: number };

export function checkSubmission(
  input: { bodyMarkdown: string; authorName: string },
  activity: RecentActivity,
  limits: SubmissionLimits,
  now: Date,
): SubmissionRejection | null {
  const body = input.bodyMarkdown.trim();

  if (body.length === 0) return { kind: 'body_empty' };
  if (body.length > limits.maxBodyLength) {
    return { kind: 'body_too_long', max: limits.maxBodyLength };
  }
  if (input.authorName.trim().length > limits.maxNameLength) {
    return { kind: 'name_too_long', max: limits.maxNameLength };
  }

  // Reposting the same text is nearly always a double-submit or a bot, and it
  // is checked before the rate limits so the user gets the accurate reason.
  if (activity.recentBodies.some((previous) => previous.trim() === body)) {
    return { kind: 'duplicate' };
  }

  const [mostRecent] = activity.timestamps;
  if (mostRecent) {
    const elapsed = (now.getTime() - mostRecent.getTime()) / 1000;
    if (elapsed < limits.minIntervalSeconds) {
      return {
        kind: 'too_fast',
        retryAfterSeconds: Math.max(1, Math.ceil(limits.minIntervalSeconds - elapsed)),
      };
    }
  }

  const windowStart = now.getTime() - limits.windowSeconds * 1000;
  const inWindow = activity.timestamps.filter((t) => t.getTime() >= windowStart);

  if (inWindow.length >= limits.maxPerWindow) {
    // The window frees up when its oldest entry falls out, so that is the
    // earliest moment a retry can succeed.
    const oldest = inWindow[inWindow.length - 1];
    const freesAt = (oldest?.getTime() ?? now.getTime()) + limits.windowSeconds * 1000;
    return {
      kind: 'too_many',
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)),
    };
  }

  return null;
}

/** Words, for the widget's counter and any length policy above it. */
export function countWords(markdown: string): number {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return 0;

  // CJK text has no spaces, so each character counts as a word; everything
  // else splits on whitespace. Matches what the widget displays.
  const cjk = trimmed.match(/[一-龥぀-ヿ가-힯]/gu)?.length ?? 0;
  const rest = trimmed
    .replaceAll(/[一-龥぀-ヿ가-힯]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean).length;

  return cjk + rest;
}
