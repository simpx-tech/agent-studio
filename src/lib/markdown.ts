import DOMPurify from 'dompurify';
import { Marked, type Token, type TokensList } from 'marked';
import type { Visualization } from './visualizations';
import type { ArtifactRecord } from './artifact-records';
import { loneImage, type SentFiles } from './sent-files';
import { siteLink } from './link-marks';
import { consoleShell, fenceClosed, type ConsoleShell } from './code-blocks';
import { artifactFence, artifactKey, artifactTitle, shownAsArtifact } from './artifacts';
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

/**
 * How a render shows artifacts (artifacts.ts): as cards in place of their code, and while their
 * reply runs, a fence still being written as the card it becomes. Only a reply's answer and its
 * own comments show them; reasoning, plans and a sub-agent's text keep every fence as code.
 */
export type ArtifactCards = 'cards' | 'writing';
let cards: ArtifactCards | undefined;
// The html and svg blocks of the text so far, which name an artifact that has no name of its
// own, and the artifacts it shows as cards.
let artifactCount = 0;
let shownCards: string[] = [];

function rendering<T>(mode: ArtifactCards | undefined, render: () => T): T {
  cards = mode;
  artifactCount = 0;
  shownCards = [];
  try {
    return render();
  } finally {
    cards = undefined;
  }
}

// An artifact in place of its code: a card that opens it in the viewer or beside the chat
// (artifactCardAction reads it back on a click). It keeps the source as text, hidden, as a
// code block keeps its code; the sanitizer allows neither <div> nor <button>, so nothing a
// model writes can make or alter one.
function artifactCard(title: string, language: 'html' | 'svg', source: string): string {
  const name = escapeAttribute(title);
  return `<div class="artifact-card" data-language="${language}"><button type="button" class="secondary artifact-open"><span>${name}</span><small>Open ${language.toUpperCase()}</small></button><button type="button" class="secondary artifact-side" aria-label="Open ${name} in side panel" title="Open in side panel"></button><pre hidden><code>${escapeAttribute(source)}</code></pre></div>\n`;
}

// An artifact its reply is still writing: the card it becomes, with how far it got.
function writingCard(title: string, source: string): string {
  const lines = source ? source.split('\n').length : 0;
  return `<div class="artifact-card artifact-writing"><span class="artifact-open"><span>${escapeAttribute(title)}</span><small>Writing · ${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}</small></span></div>\n`;
}

// A block with its Copy and Run controls (code-blocks.ts). Its code is escaped text, or
// highlight spans that highlightCode already sanitized. A fence still being written has the
// same place without the controls.
function codeBlock(text: string, info: string | undefined, raw: string): string {
  const fence = artifactFence(info);
  if (fence) {
    const closed = fenceClosed(raw);
    const index = closed ? artifactCount++ : artifactCount;
    if (cards && shownAsArtifact(fence, text) && (closed || cards === 'writing')) {
      const title = artifactTitle(fence, text, index);
      if (!closed) return writingCard(title, text);
      shownCards.push(artifactKey({ language: fence.language, source: text }));
      return artifactCard(title, fence.language, text);
    }
  }
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
// HTML in each way it shows artifacts: a link's site mark is assigned once per site for the
// session.
type Renders = { code?: string } & Partial<Record<ArtifactCards, string>>;
const rendered = new Map<string, Renders>();
let renderedSize = 0;
const maxRenderedSize = 4_000_000;

export function renderMarkdown(text: string, artifacts?: ArtifactCards): string {
  const mode = artifacts ?? 'code';
  const renders = rendered.get(text);
  if (renders) {
    rendered.delete(text);
    rendered.set(text, renders);
    const kept = renders[mode];
    if (kept !== undefined) return kept;
  }
  const html = rendering(artifacts, () =>
    withCodeBlocks(() => markdown.parse(text, { async: false })),
  );
  if (renders) renders[mode] = html;
  else rendered.set(text, { [mode]: html });
  renderedSize += (renders ? 0 : text.length) + html.length;
  // Text streamed a delta at a time leaves versions nothing asks for again; they go first.
  for (const [oldest, value] of rendered) {
    if (renderedSize <= maxRenderedSize) break;
    rendered.delete(oldest);
    renderedSize -= oldest.length;
    for (const html of Object.values(value)) renderedSize -= html.length;
  }
  return html;
}

type ReplyPart = { key: string } & (
  | { type: 'text'; html: string }
  | { type: 'visual'; visual: Visualization }
  | { type: 'artifact'; artifact: ArtifactRecord }
  | { type: 'files'; groups: SentFiles[] }
);

/** A reply's answer in its parts, and the artifacts it shows as cards (by `artifactKey`). */
export type ReplyContent = { parts: ReplyPart[]; cards: Set<string> };

/**
 * A reply's answer: its text, with each visual, artifact page and group of files at its marker
 * and each artifact fence as a card in place of its code. While the reply runs (`writing`), an
 * artifact still being written shows as the card it becomes.
 */
export function replyContent(
  text: string,
  visuals: Visualization[] = [],
  files: SentFiles[] = [],
  writing = false,
  artifacts: ArtifactRecord[] = [],
): ReplyContent {
  return rendering(writing ? 'writing' : 'cards', () => ({
    parts: answerParts(text, visuals, files, artifacts),
    cards: new Set(shownCards),
  }));
}

// Only standalone, top-level markers can position a visual, an artifact page or a group of
// files already accepted by the provider adapter. Code examples and quoted/nested markers
// remain inert.
function answerParts(
  text: string,
  visuals: Visualization[],
  files: SentFiles[],
  artifacts: ArtifactRecord[],
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
      token.raw.trim().match(/^<!-- (visualize|artifact|files):([a-zA-Z0-9_-]{1,80}) -->$/);
    if (!marker) {
      pending.push(token);
      continue;
    }
    if (marker[1] === 'visualize') {
      const visual = visuals.find((v) => v.id === marker[2]);
      if (visual) place({ key: `visual:${visual.id}`, type: 'visual', visual });
      continue;
    }
    if (marker[1] === 'artifact') {
      const artifact = artifacts.find((a) => a.id === marker[2]);
      if (artifact) place({ key: `artifact:${artifact.id}`, type: 'artifact', artifact });
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
  for (const artifact of artifacts) {
    if (!placed.has(`artifact:${artifact.id}`))
      result.push({ key: `artifact:${artifact.id}`, type: 'artifact', artifact });
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
