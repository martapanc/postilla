import type { MessageFormat } from './events.js';

/**
 * Per-format escaping for untrusted text.
 *
 * A comment body is written by a stranger and ends up in a Telegram message, a
 * Discord webhook, and an email. Each of those parses text differently, so
 * each gets its own escaper rather than one lowest-common-denominator scrub.
 */

/**
 * Markdown source to readable plain text.
 *
 * Links become `text (url)`, which is the behaviour the fork achieved by
 * regex-stripping rendered HTML. Doing it from the source instead means no
 * entity decoding, and no dependence on what the HTML renderer happened to
 * emit.
 */
export function toPlainText(markdown: string): string {
  return (
    markdown
      // Fenced and inline code: keep the contents, drop the fences.
      .replaceAll(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
      .replaceAll(/`([^`]+)`/g, '$1')
      // Images before links: the syntax differs only by a leading '!'.
      .replaceAll(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) =>
        alt ? `${alt} (${url})` : url,
      )
      .replaceAll(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
        text ? `${text} (${url})` : url,
      )
      .replaceAll(/^>\s?/gm, '')
      .replaceAll(/^#{1,6}\s+/gm, '')
      .replaceAll(/(\*\*|__)(.*?)\1/g, '$2')
      .replaceAll(/(\*|_)(.*?)\1/g, '$2')
      .replaceAll(/~~(.*?)~~/g, '$1')
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Telegram's `parse_mode: HTML` recognizes exactly these three. */
export function escapeTelegramHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Discord renders markdown, so its control characters need backslashes. */
export function escapeDiscordMarkdown(text: string): string {
  return text.replaceAll(/([\\*_~`|>[\]()#-])/g, '\\$1');
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeFor(format: MessageFormat, text: string): string {
  switch (format) {
    case 'telegram-html':
      return escapeTelegramHtml(text);
    case 'discord-markdown':
      return escapeDiscordMarkdown(text);
    case 'email-html':
      return escapeHtml(text);
    case 'plain-text':
      return text;
  }
}

/** Bold, in whichever syntax the target format understands. */
export function bold(format: MessageFormat, text: string): string {
  switch (format) {
    case 'telegram-html':
      return `<b>${text}</b>`;
    case 'discord-markdown':
      return `**${text}**`;
    case 'email-html':
      return `<strong>${text}</strong>`;
    case 'plain-text':
      return text;
  }
}

export function link(format: MessageFormat, text: string, url: string): string {
  switch (format) {
    case 'telegram-html':
      return `<a href="${escapeTelegramHtml(url)}">${text}</a>`;
    case 'discord-markdown':
      return `[${text}](${url})`;
    case 'email-html':
      return `<a href="${escapeHtml(url)}">${text}</a>`;
    case 'plain-text':
      return `${text}: ${url}`;
  }
}

/** Quoted comment body, so it reads as someone else's words. */
export function quote(format: MessageFormat, text: string): string {
  switch (format) {
    case 'telegram-html':
      return `<blockquote>${text}</blockquote>`;
    case 'discord-markdown':
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'email-html':
      return `<blockquote>${text}</blockquote>`;
    case 'plain-text':
      return text
        .split('\n')
        .map((line) => `| ${line}`)
        .join('\n');
  }
}

export function lineBreak(format: MessageFormat): string {
  return format === 'email-html' ? '<br>\n' : '\n';
}

/**
 * Keeps a message inside a channel's limit. Telegram caps at 4096 characters
 * and a long comment must not cost us the whole notification.
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
