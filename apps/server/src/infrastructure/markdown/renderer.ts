import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import type { MarkdownRenderer } from '../../ports/services.js';

/**
 * Renders untrusted comment markdown to HTML.
 *
 * Two independent stages, in this order:
 *   1. markdown-it with `html: false`, so raw HTML in the source is escaped
 *      rather than parsed.
 *   2. DOMPurify over the result, with an explicit allow-list.
 *
 * Stage 2 is not redundant. Markdown syntax alone can produce dangerous
 * output — `[click](javascript:alert(1))` is a link, not raw HTML — so the
 * sanitizer is what makes the result safe, and the escaping merely reduces
 * what reaches it.
 */

const window = new JSDOM('').window;
const purify = createDOMPurify(window);

// Anything not named here is stripped. Adding to this list is a security
// decision and should come with a test in the XSS corpus.
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'ins',
  'sub',
  'sup',
  'blockquote',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'a',
  'img',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

const ALLOWED_ATTR = ['href', 'title', 'src', 'alt', 'class', 'target', 'rel'];

export function createMarkdownRenderer(): MarkdownRenderer {
  const md = new MarkdownIt({
    // Raw HTML in a comment body is never parsed as markup.
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
  });

  return {
    render(markdown: string): string {
      const rendered = md.render(markdown);

      const clean = purify.sanitize(rendered, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        // Belt and braces: these schemes are also blocked by the sanitizer's
        // own URI policy, but naming them documents the intent.
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
        FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
        ALLOW_DATA_ATTR: false,
      });

      return hardenLinks(clean);
    },
  };
}

/**
 * Every surviving link is made safe to click: `rel="noopener noreferrer"`
 * stops the target page from reaching back through `window.opener`, and
 * `nofollow` removes the SEO incentive to spam in the first place.
 */
function hardenLinks(html: string): string {
  return html.replaceAll(/<a\s([^>]*)>/gi, (match, attrs: string) => {
    const withoutRelOrTarget = attrs
      .replaceAll(/\srel="[^"]*"/gi, '')
      .replaceAll(/\starget="[^"]*"/gi, '')
      .trim();
    return `<a ${withoutRelOrTarget} target="_blank" rel="nofollow noopener noreferrer">`;
  });
}
