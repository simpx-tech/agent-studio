import DOMPurify from 'dompurify';
import { Marked, type Token, type TokensList } from 'marked';
import type { Visualization } from './visualizations';
import { loneImage, type SentFiles } from './sent-files';
import { siteLink } from './link-marks';
import { consoleShell, fenceClosed, type ConsoleShell } from './code-blocks';
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

// Fenced code blocks of the render under way. Each goes into the page after sanitization, in
// place of the mark its fence left there: the sanitizer allows neither <div> nor <button>, so
// nothing a model writes can produce a block's controls, stand between them and the code they
// act on, or add text to that code. The mark differs in every window, so a reply cannot name it.
let fences: string[] = [];
const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36));
const fenceMark = `studio-code-${nonce.join('')}-`;
const fenceMarks = new RegExp(`${fenceMark}(\\d+);`, 'g');
function withCodeBlocks(parse: () => string): string {
  fences = [];
  const html = sanitizeMarkdown(parse());
  const blocks = fences;
  fences = [];
  return blocks.length ? html.replace(fenceMarks, (_, index) => blocks[Number(index)] ?? '') : html;
}

const runTitles: Record<ConsoleShell, string> = {
  posix: 'Run in a console, in this chat’s folder',
  powershell: 'Run in a PowerShell console, in this chat’s folder',
  cmd: 'Run in a Command Prompt, in this chat’s folder',
};

// A block with its Copy and Run controls (code-blocks.ts). Its code is escaped text, or
// highlight spans that highlightCode already sanitized. A fence still being written has the
// same place without the controls.
function codeBlock(text: string, info: string | undefined, raw: string): string {
  const highlighted = highlightCode(text, info);
  const label = info?.trim().split(/\s+/, 1)[0].toLowerCase();
  const language = highlighted?.language ?? (/^[a-z0-9_+#.-]+$/.test(label ?? '') ? label : '');
  const code = highlighted
    ? `<code class="hljs language-${language}">${highlighted.html}\n</code>`
    : `<code${language ? ` class="language-${language}"` : ''}>${escapeAttribute(text.replace(/\n$/, ''))}\n</code>`;
  const shell = consoleShell(language);
  const run = shell
    ? `<button type="button" class="code-action code-run" data-shell="${shell}" title="${runTitles[shell]}">Run</button>`
    : '';
  const actions = fenceClosed(raw)
    ? `<div class="code-actions">${run}<button type="button" class="code-action code-copy" title="Copy this code">Copy</button></div>`
    : '';
  return `<div class="code-block">${actions}<pre>${code}</pre></div>\n`;
}

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
    code({ text, lang, raw }) {
      fences.push(codeBlock(text, lang, raw));
      return `${fenceMark}${fences.length - 1};\n`;
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
  const html = withCodeBlocks(() => markdown.parse(text, { async: false }));
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
    const html = withCodeBlocks(() => markdown.parser(group));
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
  // Everything a model wrote goes through here, so source stays inert in the privileged
  // document. Fenced blocks are only marks at this point (withCodeBlocks).
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
