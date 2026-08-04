import type { SpamChecker, SpamCheckInput } from '../../ports/services.js';

/**
 * Akismet, behind the SpamChecker port.
 *
 * Deliberately fails open: if the service is unreachable, slow, or returns
 * something unexpected, the verdict is `null` — "no opinion" — and the
 * moderation policy decides on its own. A spam service outage must not take
 * the comment form down with it, and must not silently start rejecting
 * legitimate comments.
 */
export function createAkismetChecker(options: {
  apiKey: string;
  blogUrl: string;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): SpamChecker {
  const endpoint = `https://${options.apiKey}.rest.akismet.com/1.1/comment-check`;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return {
    async check(input: SpamCheckInput): Promise<'spam' | 'ham' | null> {
      const body = new URLSearchParams({
        blog: options.blogUrl,
        comment_type: 'comment',
        comment_author: input.authorName,
        comment_content: input.bodyMarkdown,
        permalink: input.permalink,
        ...(input.authorEmail ? { comment_author_email: input.authorEmail } : {}),
        ...(input.authorUrl ? { comment_author_url: input.authorUrl } : {}),
        ...(input.authorIp ? { user_ip: input.authorIp } : {}),
        ...(input.userAgent ? { user_agent: input.userAgent } : {}),
      });

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          options.onError?.(new Error(`Akismet responded ${String(response.status)}`));
          return null;
        }

        const verdict = (await response.text()).trim();

        // Akismet answers with the literal strings "true" or "false"; an
        // "invalid" body means our key or payload is wrong, not that the
        // comment is spam.
        if (verdict === 'true') return 'spam';
        if (verdict === 'false') return 'ham';

        options.onError?.(new Error(`Akismet returned an unexpected body: ${verdict}`));
        return null;
      } catch (error: unknown) {
        options.onError?.(error);
        return null;
      }
    },
  };
}

/** Used when no Akismet key is configured. */
export const noopSpamChecker: SpamChecker = {
  check: () => Promise.resolve(null),
};
