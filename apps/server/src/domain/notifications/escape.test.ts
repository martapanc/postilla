import { describe, expect, it } from 'vitest';
import {
  escapeDiscordMarkdown,
  escapeHtml,
  escapeTelegramHtml,
  toPlainText,
  truncate,
} from './escape.js';
import { reactionDedupeKey } from './coalesce.js';

describe('toPlainText', () => {
  it('renders a link as text followed by its url', () => {
    // This is the behaviour the fork achieved by regex-stripping rendered
    // HTML; doing it from the markdown source needs no entity decoding.
    expect(toPlainText('see [the docs](https://example.com)')).toBe(
      'see the docs (https://example.com)',
    );
  });

  it('keeps a bare url when the link has no text', () => {
    expect(toPlainText('[](https://example.com)')).toBe('https://example.com');
  });

  it('handles images without confusing them for links', () => {
    expect(toPlainText('![a cat](https://example.com/cat.png)')).toBe(
      'a cat (https://example.com/cat.png)',
    );
  });

  it.each([
    ['**bold**', 'bold'],
    ['__bold__', 'bold'],
    ['*italic*', 'italic'],
    ['_italic_', 'italic'],
    ['~~struck~~', 'struck'],
    ['`code`', 'code'],
    ['# Heading', 'Heading'],
    ['### Deep heading', 'Deep heading'],
    ['> quoted', 'quoted'],
  ])('strips %s', (input, expected) => {
    expect(toPlainText(input)).toBe(expected);
  });

  it('keeps the contents of a fenced code block', () => {
    expect(toPlainText('```js\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('collapses excessive blank lines', () => {
    expect(toPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves ordinary prose untouched', () => {
    expect(toPlainText('Perché no? Va bene così.')).toBe('Perché no? Va bene così.');
  });
});

describe('escapeTelegramHtml', () => {
  it('escapes exactly the three characters Telegram parses', () => {
    expect(escapeTelegramHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });

  it('escapes the ampersand first, so entities are not double-encoded', () => {
    expect(escapeTelegramHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves quotes alone, since Telegram does not parse them in text', () => {
    expect(escapeTelegramHtml(`"a" 'b'`)).toBe(`"a" 'b'`);
  });
});

describe('escapeDiscordMarkdown', () => {
  it('escapes formatting characters', () => {
    expect(escapeDiscordMarkdown('*bold* _italic_')).toBe('\\*bold\\* \\_italic\\_');
  });

  it('escapes characters that would start a block', () => {
    expect(escapeDiscordMarkdown('> quote # head - list')).toBe('\\> quote \\# head \\- list');
  });

  it('escapes the backslash itself', () => {
    expect(escapeDiscordMarkdown('a\\b')).toBe('a\\\\b');
  });
});

describe('escapeHtml', () => {
  it('escapes all five entities, including quotes for attributes', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('adds an ellipsis and stays within the limit', () => {
    const result = truncate('x'.repeat(20), 10);

    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncate('hello world', 7)).toBe('hello…');
  });
});

describe('reactionDedupeKey', () => {
  const base = { pageId: 'p1', kindKey: 'heart', windowSeconds: 900 };

  it('is stable within one window', () => {
    // Forty clicks in the same window collapse to one outbox row.
    const a = reactionDedupeKey({ ...base, now: new Date('2025-06-01T12:00:00Z') });
    const b = reactionDedupeKey({ ...base, now: new Date('2025-06-01T12:14:59Z') });

    expect(a).toBe(b);
  });

  it('changes when the window rolls over', () => {
    const a = reactionDedupeKey({ ...base, now: new Date('2025-06-01T12:14:59Z') });
    const b = reactionDedupeKey({ ...base, now: new Date('2025-06-01T12:15:00Z') });

    expect(a).not.toBe(b);
  });

  it('separates different reaction kinds', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const heart = reactionDedupeKey({ ...base, now });
    const fire = reactionDedupeKey({ ...base, kindKey: 'fire', now });

    expect(heart).not.toBe(fire);
  });

  it('separates different pages', () => {
    const now = new Date('2025-06-01T12:00:00Z');

    expect(reactionDedupeKey({ ...base, now })).not.toBe(
      reactionDedupeKey({ ...base, pageId: 'p2', now }),
    );
  });
});
