import { createTranslator, type Locale } from '@postilla/i18n';
import { bold, escapeFor, lineBreak, link, quote, toPlainText, truncate } from './escape.js';
import type {
  CommentCreatedEvent,
  MessageFormat,
  NotificationEvent,
  ReactionAddedEvent,
  RenderedMessage,
} from './events.js';

/**
 * Pure `(event, format, locale) → message`. No IO, no config lookups, no
 * clock — so the whole matrix of events × formats × locales is snapshot-
 * testable, which is the only practical way to review notification copy.
 *
 * The fork this replaces hardcoded Italian strings inside the delivery code,
 * which meant the templates could not be reviewed, translated, or tested
 * independently of the network calls around them.
 */

export interface RenderContext {
  siteName: string;
  siteUrl: string;
  /** Where the moderation dashboard lives, for the "review" link. */
  adminUrl: string;
}

/** Telegram's hard limit is 4096; leave room for the surrounding template. */
const MAX_BODY_CHARS = 1500;

export function renderNotification(
  event: NotificationEvent,
  format: MessageFormat,
  locale: Locale,
  context: RenderContext,
): RenderedMessage {
  switch (event.type) {
    case 'comment.created':
      return renderCommentCreated(event, format, locale, context);
    case 'reaction.added':
      return renderReactionAdded(event, format, locale, context);
  }
}

function renderCommentCreated(
  event: CommentCreatedEvent,
  format: MessageFormat,
  locale: Locale,
  context: RenderContext,
): RenderedMessage {
  const t = createTranslator(locale);
  const br = lineBreak(format);
  const permalink = `${context.siteUrl}${event.path}`;

  const isReply = event.replyToAuthorName !== null;
  const author = escapeFor(format, event.authorName);

  const subject = isReply
    ? t('notify.comment.reply.subject', { author: event.authorName })
    : t('notify.comment.created.subject', { siteName: context.siteName });

  const title = isReply
    ? t('notify.comment.reply.title', { author: event.authorName, siteName: context.siteName })
    : t('notify.comment.created.title', { siteName: context.siteName });

  // Built from markdown, not from rendered HTML, then escaped once for this
  // format. Truncation happens after escaping so the limit reflects what is
  // actually sent.
  const body = truncate(escapeFor(format, toPlainText(event.bodyMarkdown)), MAX_BODY_CHARS);

  const lines = [
    bold(format, escapeFor(format, title)),
    '',
    t('notify.comment.created.author', { author }),
    quote(format, body),
    '',
    t('notify.comment.created.onPage', {
      page: escapeFor(format, event.pageTitle ?? event.path),
    }),
    t('notify.comment.created.status', { status: t(`status.${event.status}`) }),
    '',
    link(format, t('notify.common.viewComment'), permalink),
  ];

  // A comment awaiting review gets a direct link to act on it.
  if (event.status === 'pending') {
    lines.push(link(format, t('notify.common.moderate'), context.adminUrl));
  }

  return { subject, body: lines.join(br) };
}

function renderReactionAdded(
  event: ReactionAddedEvent,
  format: MessageFormat,
  locale: Locale,
  context: RenderContext,
): RenderedMessage {
  const t = createTranslator(locale);
  const br = lineBreak(format);
  const permalink = `${context.siteUrl}${event.path}`;

  const title = t('notify.reaction.added.title', {
    emoji: event.emoji,
    siteName: context.siteName,
  });

  // Per-kind count leads, because the message shows that kind's emoji; the
  // page total is secondary context rather than the headline.
  const lines = [
    bold(format, escapeFor(format, title)),
    '',
    t('notify.reaction.added.kindTotal', { emoji: event.emoji, count: event.kindTotal }),
    t('notify.reaction.added.pageTotal', { count: event.pageTotal }),
    '',
    t('notify.comment.created.onPage', {
      page: escapeFor(format, event.pageTitle ?? event.path),
    }),
    '',
    link(format, t('notify.common.viewPage'), permalink),
  ];

  return { subject: title, body: lines.join(br) };
}
