import { describe, expect, it } from 'vitest';
import {
  checkSubmission,
  countWords,
  type RecentActivity,
  type SubmissionLimits,
} from './submission.js';

const NOW = new Date('2025-06-01T12:00:00Z');
const secondsAgo = (n: number): Date => new Date(NOW.getTime() - n * 1000);

const limits = (over: Partial<SubmissionLimits> = {}): SubmissionLimits => ({
  minIntervalSeconds: 15,
  maxPerWindow: 3,
  windowSeconds: 3600,
  maxBodyLength: 100,
  maxNameLength: 20,
  ...over,
});

const activity = (over: Partial<RecentActivity> = {}): RecentActivity => ({
  timestamps: [],
  recentBodies: [],
  ...over,
});

const submission = { bodyMarkdown: 'hello there', authorName: 'Someone' };

describe('checkSubmission — shape', () => {
  it('accepts an ordinary comment', () => {
    expect(checkSubmission(submission, activity(), limits(), NOW)).toBeNull();
  });

  it('rejects an empty body', () => {
    expect(checkSubmission({ ...submission, bodyMarkdown: '' }, activity(), limits(), NOW)).toEqual(
      {
        kind: 'body_empty',
      },
    );
  });

  it('rejects a whitespace-only body', () => {
    expect(
      checkSubmission({ ...submission, bodyMarkdown: '   \n\t ' }, activity(), limits(), NOW),
    ).toEqual({ kind: 'body_empty' });
  });

  it('rejects an over-long body', () => {
    const result = checkSubmission(
      { ...submission, bodyMarkdown: 'x'.repeat(101) },
      activity(),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'body_too_long', max: 100 });
  });

  it('measures length after trimming', () => {
    const body = `  ${'x'.repeat(100)}  `;

    expect(
      checkSubmission({ ...submission, bodyMarkdown: body }, activity(), limits(), NOW),
    ).toBeNull();
  });

  it('rejects an over-long name', () => {
    const result = checkSubmission(
      { ...submission, authorName: 'x'.repeat(21) },
      activity(),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'name_too_long', max: 20 });
  });
});

describe('checkSubmission — duplicates', () => {
  it('rejects a repost of the same text', () => {
    const result = checkSubmission(
      submission,
      activity({ recentBodies: ['hello there'] }),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'duplicate' });
  });

  it('ignores surrounding whitespace when comparing', () => {
    const result = checkSubmission(
      submission,
      activity({ recentBodies: ['  hello there\n'] }),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'duplicate' });
  });

  it('allows different text', () => {
    expect(
      checkSubmission(submission, activity({ recentBodies: ['something else'] }), limits(), NOW),
    ).toBeNull();
  });

  it('reports duplicate before rate limits, so the reason is accurate', () => {
    // Both conditions hold; the user should be told what actually happened.
    const result = checkSubmission(
      submission,
      activity({ recentBodies: ['hello there'], timestamps: [secondsAgo(1)] }),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'duplicate' });
  });
});

describe('checkSubmission — rate limits', () => {
  it('rejects a comment posted too soon after the last', () => {
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(5)] }),
      limits(),
      NOW,
    );

    expect(result).toMatchObject({ kind: 'too_fast' });
    expect(result).toHaveProperty('retryAfterSeconds', 10);
  });

  it('allows one posted exactly at the interval', () => {
    expect(
      checkSubmission(submission, activity({ timestamps: [secondsAgo(15)] }), limits(), NOW),
    ).toBeNull();
  });

  it('rejects when the window is full', () => {
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(60), secondsAgo(120), secondsAgo(180)] }),
      limits(),
      NOW,
    );

    expect(result).toMatchObject({ kind: 'too_many' });
  });

  it('reports when the window will actually free up', () => {
    // The oldest entry leaves the window 3600s after it was made.
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(60), secondsAgo(120), secondsAgo(3000)] }),
      limits(),
      NOW,
    );

    expect(result).toEqual({ kind: 'too_many', retryAfterSeconds: 600 });
  });

  it('ignores comments that have already fallen out of the window', () => {
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(4000), secondsAgo(5000), secondsAgo(6000)] }),
      limits(),
      NOW,
    );

    expect(result).toBeNull();
  });

  it('never reports a retry delay below one second', () => {
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(14.99)] }),
      limits(),
      NOW,
    );

    expect(result).toMatchObject({ kind: 'too_fast', retryAfterSeconds: 1 });
  });

  it('imposes no limit on an author with no history', () => {
    expect(checkSubmission(submission, activity(), limits(), NOW)).toBeNull();
  });

  it('can be disabled by setting the interval to zero', () => {
    const result = checkSubmission(
      submission,
      activity({ timestamps: [secondsAgo(0)] }),
      limits({ minIntervalSeconds: 0 }),
      NOW,
    );

    expect(result).toBeNull();
  });
});

describe('countWords', () => {
  it.each([
    ['', 0],
    ['   ', 0],
    ['hello', 1],
    ['hello world', 2],
    ['  spaced   out  words ', 3],
    ['line\nbreaks\tcount', 3],
  ])('counts %j as %i', (input, expected) => {
    expect(countWords(input)).toBe(expected);
  });

  it('counts each CJK character as a word', () => {
    expect(countWords('日本語')).toBe(3);
  });

  it('handles mixed scripts', () => {
    expect(countWords('hello 日本')).toBe(3);
  });
});
