import { describe, expect, it } from 'vitest';
import { renderNotification, type RenderContext } from './render.js';
import type { CommentCreatedEvent, MessageFormat, ReactionAddedEvent } from './events.js';
import type { Locale } from '@postilla/i18n';

const context: RenderContext = {
  siteName: 'No True Feminist',
  siteUrl: 'https://notruefeminist.com',
  adminUrl: 'https://comments.example/admin',
};

const FORMATS: MessageFormat[] = ['telegram-html', 'discord-markdown', 'email-html', 'plain-text'];
const LOCALES: Locale[] = ['en', 'it'];

const comment: CommentCreatedEvent = {
  type: 'comment.created',
  commentId: 'c1',
  path: '/la-societa-italiana-e-patriarcale',
  pageTitle: 'La società italiana è patriarcale',
  authorName: 'Wanblee',
  bodyMarkdown: 'Complimenti per **questo articolo**!\n\nVedi [la fonte](https://example.com).',
  status: 'approved',
  replyToAuthorName: null,
};

const reaction: ReactionAddedEvent = {
  type: 'reaction.added',
  path: '/perche-no-true-feminist',
  pageTitle: 'Perché No True Feminist',
  kindKey: 'heart',
  emoji: '❤️',
  kindTotal: 32,
  pageTotal: 55,
  delta: 3,
};

/**
 * The full matrix, snapshotted. Notification copy is only reviewable if you
 * can see it, and these are the artefact a reviewer reads — 2 events × 4
 * formats × 2 locales.
 */
describe('renderNotification — snapshots', () => {
  for (const format of FORMATS) {
    for (const locale of LOCALES) {
      it(`comment.created / ${format} / ${locale}`, () => {
        expect(renderNotification(comment, format, locale, context)).toMatchSnapshot();
      });

      it(`reaction.added / ${format} / ${locale}`, () => {
        expect(renderNotification(reaction, format, locale, context)).toMatchSnapshot();
      });
    }
  }
});

describe('renderNotification — properties that must hold everywhere', () => {
  it.each(FORMATS)('includes the permalink (%s)', (format) => {
    const message = renderNotification(comment, format, 'it', context);

    expect(message.body).toContain('https://notruefeminist.com/la-societa-italiana-e-patriarcale');
  });

  it.each(FORMATS)('never leaks raw markdown syntax into the body (%s)', (format) => {
    const message = renderNotification(
      { ...comment, bodyMarkdown: '**shouty** and [linked](https://e.example)' },
      format,
      'en',
      context,
    );

    // Bold markers are stripped and a link becomes "text (url)". The
    // parentheses may themselves be escaped afterwards — Discord requires it —
    // so the assertion checks the parts, not the punctuation.
    expect(message.body).not.toContain('**shouty**');
    expect(message.body).toContain('shouty');
    expect(message.body).toContain('linked');
    expect(message.body).toContain('https://e.example');
  });

  it.each(FORMATS)('adds a moderation link only when pending (%s)', (format) => {
    const approved = renderNotification(comment, format, 'en', context);
    const pending = renderNotification({ ...comment, status: 'pending' }, format, 'en', context);

    expect(approved.body).not.toContain(context.adminUrl);
    expect(pending.body).toContain(context.adminUrl);
  });

  it.each(FORMATS)('reports both the per-kind and page totals (%s)', (format) => {
    // The inconsistency this replaces: one call site sent the per-kind count,
    // the other the sum across all kinds. Both are present now, unambiguously.
    const message = renderNotification(reaction, format, 'en', context);

    expect(message.body).toContain('32');
    expect(message.body).toContain('55');
  });

  it('renders Italian when the locale is it', () => {
    const message = renderNotification(comment, 'telegram-html', 'it', context);

    expect(message.body).toContain('Nuovo commento su');
    expect(message.body).toContain('ha scritto');
    expect(message.subject).toContain('Nuovo commento');
  });

  it('renders English when the locale is en', () => {
    const message = renderNotification(comment, 'telegram-html', 'en', context);

    expect(message.body).toContain('New comment on');
    expect(message.body).toContain('wrote:');
  });

  it('uses reply wording when the comment is a reply', () => {
    const message = renderNotification(
      { ...comment, replyToAuthorName: 'marta_ntf' },
      'plain-text',
      'it',
      context,
    );

    expect(message.subject).toContain('ha risposto');
  });

  it('falls back to the path when the page has no title', () => {
    const message = renderNotification(
      { ...comment, pageTitle: null },
      'plain-text',
      'en',
      context,
    );

    expect(message.body).toContain('/la-societa-italiana-e-patriarcale');
  });

  it('truncates a very long body rather than losing the whole message', () => {
    const message = renderNotification(
      { ...comment, bodyMarkdown: 'x'.repeat(5000) },
      'telegram-html',
      'en',
      context,
    );

    // Telegram's limit is 4096; the message must survive intact.
    expect(message.body.length).toBeLessThan(4096);
    expect(message.body).toContain('…');
  });
});

describe('renderNotification — escaping is applied per format', () => {
  const hostile: CommentCreatedEvent = {
    ...comment,
    authorName: '<script>alert(1)</script>',
    bodyMarkdown: 'a < b & c > d',
  };

  it('escapes HTML entities for Telegram', () => {
    const message = renderNotification(hostile, 'telegram-html', 'en', context);

    expect(message.body).not.toContain('<script>');
    expect(message.body).toContain('&lt;script&gt;');
  });

  it('escapes markdown control characters for Discord', () => {
    const message = renderNotification(
      { ...comment, authorName: 'a*b_c`d' },
      'discord-markdown',
      'en',
      context,
    );

    expect(message.body).toContain('a\\*b\\_c\\`d');
  });

  it('leaves plain text unescaped', () => {
    const message = renderNotification(hostile, 'plain-text', 'en', context);

    expect(message.body).toContain('a < b & c > d');
  });
});
