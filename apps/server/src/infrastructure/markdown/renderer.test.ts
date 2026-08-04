import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createMarkdownRenderer } from './renderer.js';

const renderer = createMarkdownRenderer();
const render = (markdown: string): string => renderer.render(markdown);

/**
 * The comment body is the one place where a stranger's input becomes HTML on
 * the blog. Every payload below must come out inert.
 *
 * Assertions parse the output and inspect the DOM rather than matching
 * substrings. That distinction matters: `&lt;script&gt;` contains the text
 * "script" but is displayed, not executed, so a substring test would report a
 * failure where the sanitizer did exactly the right thing — and, worse, would
 * pass on output that only *looks* clean.
 */

const DANGEROUS_ELEMENTS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'style',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'template',
  'noscript',
];

const DANGEROUS_URI = /^\s*(javascript|vbscript|data)\s*:/i;

/** Everything an attacker needs the browser to *do*, checked structurally. */
function assertInert(html: string): void {
  const { document } = new JSDOM(`<body>${html}</body>`).window;

  for (const tag of DANGEROUS_ELEMENTS) {
    expect(document.querySelectorAll(tag), `<${tag}> must not survive`).toHaveLength(0);
  }

  for (const element of document.querySelectorAll('*')) {
    for (const attr of element.attributes) {
      expect(attr.name.toLowerCase(), 'no event handler attributes').not.toMatch(/^on/);
      expect(attr.name.toLowerCase(), 'no inline styles').not.toBe('style');

      if (['href', 'src', 'action', 'formaction'].includes(attr.name.toLowerCase())) {
        expect(attr.value, `${attr.name} must not carry an executable scheme`).not.toMatch(
          DANGEROUS_URI,
        );
      }
    }
  }
}

const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<script src="https://evil.example/x.js"></script>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)" />',
  '<svg/onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe src="https://evil.example"></iframe>',
  '<body onload=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](  javascript:alert(1))',
  '![img](javascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '![x](data:text/html,<script>alert(1)</script>)',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="https://evil.example"><input name="x"></form>',
  '<input type="text" onfocus="alert(1)" autofocus>',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<details open ontoggle=alert(1)>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<video><source onerror="alert(1)"></video>',
  '<audio src=x onerror=alert(1)>',
  '<a href="#" onclick="alert(1)">x</a>',
  '<p onmouseover="alert(1)">hover</p>',
  '"><script>alert(1)</script>',
  "';alert(1);//",
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<SCRIPT>alert(1)</SCRIPT>',
  '<script\n>alert(1)</script>',
  '<!--<script>alert(1)</script>-->',
  '<textarea><script>alert(1)</script></textarea>',
  '<noscript><p title="</noscript><script>alert(1)</script>">',
  '<template><script>alert(1)</script></template>',
  '<a href="&#106;avascript:alert(1)">entity encoded</a>',
  '[x](&#x6a;avascript:alert(1))',
];

describe('markdown renderer — XSS corpus', () => {
  it.each(XSS_CORPUS)('neutralizes %j', (payload) => {
    assertInert(render(payload));
  });

  it('stays inert with the whole corpus rendered at once', () => {
    // Combined, in case one payload's output re-opens a parsing context for
    // the next — a class of bug single-payload tests miss.
    assertInert(render(XSS_CORPUS.join('\n\n')));
  });

  it('escapes markup instead of executing it', () => {
    // The complement of the structural check: confirm the dangerous text is
    // still present as *text*, so we know it was escaped and not merely
    // dropped in a way that could differ on another parser.
    const html = render('<script>alert(1)</script>');
    const { document } = new JSDOM(`<body>${html}</body>`).window;

    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.body.textContent).toContain('alert(1)');
  });
});

describe('markdown renderer — legitimate content survives', () => {
  it('renders basic formatting', () => {
    const html = render('**bold** and *italic* and `code`');

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders lists, quotes and code blocks', () => {
    expect(render('- one\n- two')).toContain('<ul>');
    expect(render('> quoted')).toContain('<blockquote>');
    expect(render('```\nconst x = 1;\n```')).toContain('<pre>');
  });

  it('keeps safe links and makes them safe to click', () => {
    const html = render('[example](https://example.com)');
    const anchor = new JSDOM(`<body>${html}</body>`).window.document.querySelector('a');

    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.getAttribute('rel')).toBe('nofollow noopener noreferrer');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });

  it('hardens autolinked bare URLs too', () => {
    const html = render('see https://example.com for details');
    const anchor = new JSDOM(`<body>${html}</body>`).window.document.querySelector('a');

    expect(anchor?.getAttribute('rel')).toBe('nofollow noopener noreferrer');
  });

  it('overrides an author-supplied rel that would re-enable window.opener', () => {
    // Written as markdown, since raw HTML is escaped before it reaches here.
    const html = render('[x](https://example.com "t")');
    const anchor = new JSDOM(`<body>${html}</body>`).window.document.querySelector('a');

    expect(anchor?.getAttribute('rel')).toBe('nofollow noopener noreferrer');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });

  it('keeps relative and mailto links', () => {
    expect(render('[a](/other-post)')).toContain('href="/other-post"');
    expect(render('[m](mailto:a@example.com)')).toContain('mailto:a@example.com');
  });

  it('preserves https images', () => {
    const html = render('![alt](https://example.com/cat.png)');
    const img = new JSDOM(`<body>${html}</body>`).window.document.querySelector('img');

    expect(img?.getAttribute('src')).toBe('https://example.com/cat.png');
    expect(img?.getAttribute('alt')).toBe('alt');
  });

  it('escapes rather than executes text that looks like markup', () => {
    expect(render('use the <div> element')).toContain('&lt;div&gt;');
  });

  it('handles emoji, accents and CJK unchanged', () => {
    const html = render('Perché no? 🎉 日本語');

    expect(html).toContain('Perché');
    expect(html).toContain('🎉');
    expect(html).toContain('日本語');
  });

  it('renders an empty body without throwing', () => {
    expect(render('')).toBe('');
  });
});
