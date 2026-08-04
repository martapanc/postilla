export type ModerationDecision = 'approved' | 'pending' | 'spam';

export interface ModerationConfig {
  /** Hold every comment for review. */
  auditAll: boolean;
  /**
   * Hold only a commenter's *first* comment. Once they have one approved,
   * later comments from the same email are published immediately.
   */
  auditFirstOnly: boolean;
  /** Case-insensitive substrings that mark a comment as spam outright. */
  forbiddenWords: readonly string[];
}

export interface ModerationInput {
  bodyMarkdown: string;
  authorName: string;
  authorEmailHash: string | null;
  /** True when the author is a signed-in admin or moderator. */
  isAuthenticatedStaff: boolean;
  /** Whether this email has ever had a comment approved. */
  hasPriorApprovedComment: boolean;
  /** Null when no spam checker is configured. */
  spamVerdict: 'spam' | 'ham' | null;
}

export interface ModerationResult {
  decision: ModerationDecision;
  /** Machine-readable justification, recorded in the moderation log. */
  reason: string;
  matchedForbiddenWords: string[];
}

/**
 * Decides whether a comment is published, held, or rejected.
 *
 * Pure by construction: no database, no clock, no network. Everything it needs
 * — including whether the author has commented before — is passed in, so the
 * whole decision table is exhaustively testable without fixtures.
 *
 * In the system this replaces, these rules were an inline `if` in a
 * 774-line controller.
 */
export function decideModeration(
  input: ModerationInput,
  config: ModerationConfig,
): ModerationResult {
  const matchedForbiddenWords = findForbiddenWords(input, config.forbiddenWords);

  // Staff bypass everything. They can already approve their own comment, so
  // holding it would only add a step.
  if (input.isAuthenticatedStaff) {
    return { decision: 'approved', reason: 'authenticated_staff', matchedForbiddenWords: [] };
  }

  // A forbidden word outranks the spam service: it is an explicit, local rule
  // and a third party should not be able to overrule it.
  if (matchedForbiddenWords.length > 0) {
    return { decision: 'spam', reason: 'forbidden_word', matchedForbiddenWords };
  }

  if (input.spamVerdict === 'spam') {
    return { decision: 'spam', reason: 'spam_service', matchedForbiddenWords };
  }

  if (config.auditAll) {
    return { decision: 'pending', reason: 'audit_all', matchedForbiddenWords };
  }

  if (config.auditFirstOnly) {
    return input.hasPriorApprovedComment
      ? { decision: 'approved', reason: 'known_commenter', matchedForbiddenWords }
      : { decision: 'pending', reason: 'first_comment', matchedForbiddenWords };
  }

  return { decision: 'approved', reason: 'no_audit_configured', matchedForbiddenWords };
}

/**
 * Scans the fields a spammer actually fills in. Matching is case-insensitive
 * and substring-based: deliberately blunt, because the cost of a false
 * positive here is a comment held for review, not one lost.
 */
function findForbiddenWords(input: ModerationInput, forbiddenWords: readonly string[]): string[] {
  if (forbiddenWords.length === 0) return [];

  const haystack = `${input.bodyMarkdown}\n${input.authorName}`.toLowerCase();

  return forbiddenWords.filter((word) => {
    const needle = word.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
