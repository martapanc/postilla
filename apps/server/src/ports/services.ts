/**
 * Collaborators the application needs that are not persistence. Each has a
 * no-op or deterministic fake for tests, which is what keeps the use cases
 * runnable without network access.
 */

export interface MarkdownRenderer {
  /** Renders untrusted markdown to HTML that is safe to inject into a page. */
  render(markdown: string): string;
}

export interface SpamCheckInput {
  bodyMarkdown: string;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  authorIp: string | null;
  userAgent: string | null;
  permalink: string;
}

export interface SpamChecker {
  /** Null means "no opinion" — unconfigured, or the service was unreachable. */
  check(input: SpamCheckInput): Promise<'spam' | 'ham' | null>;
}

export interface CaptchaVerifier {
  /** True when no captcha is configured, so the caller needs no special case. */
  verify(token: string | null, remoteIp: string | null): Promise<boolean>;
}

/** Injected so time-dependent behaviour can be tested without waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
