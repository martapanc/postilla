import { describe, expect, it } from 'vitest';
import { decideModeration, type ModerationConfig, type ModerationInput } from './policy.js';

const input = (over: Partial<ModerationInput> = {}): ModerationInput => ({
  bodyMarkdown: 'a perfectly ordinary comment',
  authorName: 'Someone',
  authorEmailHash: 'hash',
  isAuthenticatedStaff: false,
  hasPriorApprovedComment: false,
  spamVerdict: null,
  ...over,
});

const config = (over: Partial<ModerationConfig> = {}): ModerationConfig => ({
  auditAll: false,
  auditFirstOnly: false,
  forbiddenWords: [],
  ...over,
});

describe('decideModeration — precedence', () => {
  it('lets staff through regardless of every other signal', () => {
    const result = decideModeration(
      input({ isAuthenticatedStaff: true, spamVerdict: 'spam', bodyMarkdown: 'buy viagra' }),
      config({ auditAll: true, forbiddenWords: ['viagra'] }),
    );

    expect(result.decision).toBe('approved');
    expect(result.reason).toBe('authenticated_staff');
  });

  it('lets a local forbidden word outrank the spam service saying ham', () => {
    // A third-party service must not be able to overrule an explicit local rule.
    const result = decideModeration(
      input({ bodyMarkdown: 'buy viagra now', spamVerdict: 'ham' }),
      config({ forbiddenWords: ['viagra'] }),
    );

    expect(result.decision).toBe('spam');
    expect(result.reason).toBe('forbidden_word');
    expect(result.matchedForbiddenWords).toEqual(['viagra']);
  });

  it('treats a spam verdict as spam even when auditing is on', () => {
    const result = decideModeration(input({ spamVerdict: 'spam' }), config({ auditAll: true }));

    expect(result.decision).toBe('spam');
    expect(result.reason).toBe('spam_service');
  });
});

describe('decideModeration — audit modes', () => {
  it('approves everything when no audit is configured', () => {
    const result = decideModeration(input(), config());

    expect(result.decision).toBe('approved');
    expect(result.reason).toBe('no_audit_configured');
  });

  it('holds every comment when auditAll is on', () => {
    const result = decideModeration(
      input({ hasPriorApprovedComment: true }),
      config({ auditAll: true }),
    );

    expect(result.decision).toBe('pending');
    expect(result.reason).toBe('audit_all');
  });

  it('holds a first-time commenter under auditFirstOnly', () => {
    const result = decideModeration(
      input({ hasPriorApprovedComment: false }),
      config({ auditFirstOnly: true }),
    );

    expect(result.decision).toBe('pending');
    expect(result.reason).toBe('first_comment');
  });

  it('publishes a known commenter under auditFirstOnly', () => {
    const result = decideModeration(
      input({ hasPriorApprovedComment: true }),
      config({ auditFirstOnly: true }),
    );

    expect(result.decision).toBe('approved');
    expect(result.reason).toBe('known_commenter');
  });

  it('lets auditAll win over auditFirstOnly when both are set', () => {
    // The stricter setting has to win, or enabling both would be laxer than
    // enabling one — a genuinely surprising configuration outcome.
    const result = decideModeration(
      input({ hasPriorApprovedComment: true }),
      config({ auditAll: true, auditFirstOnly: true }),
    );

    expect(result.decision).toBe('pending');
    expect(result.reason).toBe('audit_all');
  });

  it('holds an anonymous commenter under auditFirstOnly', () => {
    // No email means no way to recognize them, so they are always "first".
    const result = decideModeration(
      input({ authorEmailHash: null, hasPriorApprovedComment: false }),
      config({ auditFirstOnly: true }),
    );

    expect(result.decision).toBe('pending');
  });
});

describe('decideModeration — forbidden words', () => {
  it('matches case-insensitively', () => {
    const result = decideModeration(
      input({ bodyMarkdown: 'BUY ViAgRa' }),
      config({ forbiddenWords: ['viagra'] }),
    );

    expect(result.decision).toBe('spam');
  });

  it('matches inside a larger word, deliberately', () => {
    // Blunt on purpose: a false positive costs a review, a miss costs spam.
    const result = decideModeration(
      input({ bodyMarkdown: 'superviagraplus' }),
      config({ forbiddenWords: ['viagra'] }),
    );

    expect(result.decision).toBe('spam');
  });

  it('scans the author name as well as the body', () => {
    const result = decideModeration(
      input({ authorName: 'Casino Bonus' }),
      config({ forbiddenWords: ['casino'] }),
    );

    expect(result.decision).toBe('spam');
  });

  it('reports every word that matched', () => {
    const result = decideModeration(
      input({ bodyMarkdown: 'viagra and casino' }),
      config({ forbiddenWords: ['viagra', 'casino', 'poker'] }),
    );

    expect(result.matchedForbiddenWords).toEqual(['viagra', 'casino']);
  });

  it('ignores blank entries in the word list', () => {
    // A trailing comma in the env var must not blocklist every comment.
    const result = decideModeration(
      input({ bodyMarkdown: 'hello' }),
      config({ forbiddenWords: ['', '  ', 'viagra'] }),
    );

    expect(result.decision).toBe('approved');
  });

  it('is unaffected by an empty word list', () => {
    expect(decideModeration(input(), config({ forbiddenWords: [] })).decision).toBe('approved');
  });
});

describe('decideModeration — spam service', () => {
  it('treats a null verdict as no opinion', () => {
    // The adapter returns null when the service is unreachable; an outage must
    // not start rejecting legitimate comments.
    const result = decideModeration(input({ spamVerdict: null }), config());

    expect(result.decision).toBe('approved');
  });

  it('does not let a ham verdict bypass auditing', () => {
    const result = decideModeration(input({ spamVerdict: 'ham' }), config({ auditAll: true }));

    expect(result.decision).toBe('pending');
  });
});
