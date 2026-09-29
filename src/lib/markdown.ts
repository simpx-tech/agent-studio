import DOMPurify from 'dompurify';
import { Marked, type Token, type TokensList } from 'marked';
import type { Visualization } from './visualizations';
import { loneImage, type SentFiles } from './sent-files';
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

// Recently rendered text, the least recently used first. A reply's progress and reasoning and a
// sub-agent's conversation render their unchanged text again on every update, which parsed and
// sanitized each message again as the conversation grew. The same text always renders the same
// HTML: a link's site mark is assigned once per site for the session.
const rendered = new Map<string, string>();
let renderedSize = 0;
const maxRenderedSize = 4_000_000;

export function renderMarkdown(text: string): string {
  const kept = rendered.get(text);
  if (kept !== undefined) {
    rendered.delete(text);
    rendered.set(text, kept);
    return kept;
  }
  const html = sanitizeMarkdown(markdown.parse(text, { async: false }));
  rendered.set(text, html);
  renderedSize += text.length + html.length;
  // Text streamed a delta at a time leaves versions nothing asks for again; they go first.
  for (const [oldest, value] of rendered) {
    if (renderedSize <= maxRenderedSize) break;
    rendered.delete(oldest);
    renderedSize -= oldest.length + value.length;
  }
  return html;
}

type ReplyPart = { key: string } & (
  | { type: 'text'; html: string }
  | { type: 'visual'; visual: Visualization }
  | { type: 'files'; groups: SentFiles[] }
);

// Only standalone, top-level markers can position a visual or a group of files already
// accepted by the provider adapter. Code examples and quoted/nested markers remain inert.
export function replyContent(
  text: string,
  visuals: Visualization[] = [],
  files: SentFiles[] = [],
): ReplyPart[] {
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
  function place(part: ReplyPart & { key: string }) {
    if (placed.has(part.key)) return false;
    flush();
    result.push(part);
    placed.add(part.key);
    key = `text:${part.key}`;
    return true;
  }
  /** Places a group, joining single pictures sent one call at a time into one gallery. */
  function placeFiles(group: SentFiles) {
    const id = `files:${group.id}`;
    if (placed.has(id)) return;
    flush();
    const last = result.at(-1);
    if (last?.type === 'files' && loneImage(group) && last.groups.every(loneImage))
      last.groups.push(group);
    else result.push({ key: id, type: 'files', groups: [group] });
    placed.add(id);
    key = `text:${id}`;
  }
  for (const token of tokens) {
    const marker =
      token.type === 'html' &&
      token.raw.trim().match(/^<!-- (visualize|files):([a-zA-Z0-9_-]{1,80}) -->$/);
    if (!marker) {
      pending.push(token);
      continue;
    }
    if (marker[1] === 'visualize') {
      const visual = visuals.find((v) => v.id === marker[2]);
      if (visual) place({ key: `visual:${visual.id}`, type: 'visual', visual });
      continue;
    }
    const group = files.find((f) => f.id === marker[2]);
    if (group) placeFiles(group);
  }
  flush();
  // Older replies and content received before its prose keep an inline fallback.
  for (const visual of visuals) {
    if (!placed.has(`visual:${visual.id}`))
      result.push({ key: `visual:${visual.id}`, type: 'visual', visual });
  }
  for (const group of files) placeFiles(group);
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
