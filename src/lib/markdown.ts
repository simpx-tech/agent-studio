import DOMPurify from 'dompurify';
import { Marked, type Token, type TokensList } from 'marked';
import type { Visualization } from './visualizations';
import { siteLink } from './link-marks';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);

// Keep streaming renders bounded; unsupported or large blocks use Marked's escaped fallback.
const maxHighlightedCodeLength = 64 * 1024;

// Only presentation spans leave this boundary. Callers can safely display the result
// as HTML, while falling back to their normal escaped text when highlighting is unavailable.
export function highlightCode(
  text: string,
  info?: string,
): { language: string; html: string } | null {
  const language = info?.trim().split(/\s+/, 1)[0].toLowerCase();
  if (
    !language ||
    !/^[a-z0-9_+#.-]+$/.test(language) ||
    !hljs.getLanguage(language) ||
    text.length > maxHighlightedCodeLength
  )
    return null;
  try {
    const html = DOMPurify.sanitize(
      hljs.highlight(text, { language, ignoreIllegals: true }).value,
      {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class'],
        ALLOW_DATA_ATTR: false,
      },
    );
    return { language, html };
  } catch {
    return null;
  }
}

const attributeEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};
const escapeAttribute = (value: string) =>
  value.replace(/[&<>"]/g, (character) => attributeEntities[character]);
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Links a browser would open as a page carry their site's mark; every other link,
    // and every address Marked itself rejects, keeps its plain anchor.
    link({ href, title, tokens }) {
      const site = siteLink(href);
      if (!site) return false;
      const name = title ? ` title="${escapeAttribute(title)}"` : '';
      return `<a href="${escapeAttribute(site.href)}"${name}><span class="link-mark ${site.mark}"></span>${this.parser.parseInline(tokens)}</a>`;
    },
    code({ text, lang }) {
      const highlighted = highlightCode(text, lang);
      if (!highlighted) return false;
      return `<pre><code class="hljs language-${highlighted.language}">${highlighted.html}\n</code></pre>\n`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return sanitizeMarkdown(markdown.parse(text, { async: false }));
}

type ReplyPart = { key: string } & (
  { type: 'text'; html: string } | { type: 'visual'; visual: Visualization }
);

// Only standalone, top-level markers can position a visual already accepted by
// the provider adapter. Code examples and quoted/nested markers remain inert.
export function replyContent(text: string, visuals: Visualization[] = []): ReplyPart[] {
  const tokens = markdown.lexer(text);
  const result: ReplyPart[] = [];
  const placed = new Set<string>();
  let pending: Token[] = [];
  let key = 'text:start';
  function flush() {
    if (!pending.length) return;
    const group = Object.assign(pending, { links: tokens.links }) as TokensList;
    const html = sanitizeMarkdown(markdown.parser(group));
    if (html.trim()) result.push({ key, type: 'text', html });
    pending = [];
  }
  for (const token of tokens) {
    const marker =
      token.type === 'html' && token.raw.trim().match(/^<!-- visualize:([a-zA-Z0-9_-]{1,80}) -->$/);
    if (!marker) {
      pending.push(token);
      continue;
    }
    const visual = visuals.find((v) => v.id === marker[1]);
    if (!visual || placed.has(visual.id)) continue;
    flush();
    result.push({ key: `visual:${visual.id}`, type: 'visual', visual });
    placed.add(visual.id);
    key = `text:${visual.id}`;
  }
  flush();
  // Older replies and visuals received before their prose keep an inline fallback.
  for (const visual of visuals) {
    if (!placed.has(visual.id)) result.push({ key: `visual:${visual.id}`, type: 'visual', visual });
  }
  return result;
}

function sanitizeMarkdown(html: string): string {
  // Sanitize after highlighting so source code remains inert in the privileged document.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'span',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
      'hr',
      'input',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
  });
}
