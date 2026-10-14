import { marked } from 'marked';
import { fenceClosed } from './code-blocks';
import type { Message } from './domain';
import type { ArtifactRecord } from './artifact-records';

export type Artifact = {
  id: string;
  title: string;
  language: 'html' | 'svg';
  source: string;
  visualization?: boolean;
  revision?: number;
};

/** An html or svg fence: its language and the name its opening line gives it after that. */
export type ArtifactFence = { language: 'html' | 'svg'; name: string };

export function artifactFence(info: string | undefined): ArtifactFence | undefined {
  const language = info?.split(/\s/)[0]?.toLowerCase();
  if (language !== 'html' && language !== 'svg') return undefined;
  const name = info!
    .slice(language.length)
    .trim()
    .replace(/^title=/, '')
    .replace(/^['"]|['"]$/g, '');
  return { language, name };
}

// A whole HTML page, perhaps after comments: a doctype or its html element.
const wholeDocument = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>/])/i;

/**
 * Whether a fence holds an artifact the reply shows as a card rather than as code: its opening
 * fence names it (```html Sales report), as Agent Studio asks models to write artifacts, or it
 * holds a whole HTML page. Other html and svg blocks stay code, and open from below the reply.
 */
export function shownAsArtifact(fence: ArtifactFence, source: string): boolean {
  return !!fence.name || (fence.language === 'html' && wholeDocument.test(source));
}

/** An artifact's title: its fence's name, its page's title, or its place among the reply's. */
export function artifactTitle(fence: ArtifactFence, source: string, index: number): string {
  const htmlTitle = source.match(/<title[^>]*>([^<]{1,100})<\/title>/i)?.[1];
  const title = fence.name || htmlTitle || `${fence.language.toUpperCase()} artifact ${index + 1}`;
  return title.slice(0, 100);
}

/**
 * A page a reply showed with its show_artifact tool, as the viewer opens it: the id follows the
 * page through its revisions, so an open viewer shows the latest one.
 */
export function recordArtifact(messageId: string, record: ArtifactRecord): Artifact {
  return {
    id: `${messageId}:artifact:${record.id}`,
    title: record.title,
    language: record.language,
    source: record.source,
    revision: record.revision,
  };
}

/** What tells two artifacts apart: the same source in the same language is one artifact. */
export function artifactKey(artifact: Pick<Artifact, 'language' | 'source'>): string {
  return `${artifact.language}\n${artifact.source}`;
}

// Only complete, explicitly labelled output blocks become artifacts. Never read
// provider tool arguments or arbitrary local paths to manufacture a preview.
export function responseArtifacts(text: string, messageId: string): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const token of marked.lexer(text)) {
    if (token.type !== 'code') continue;
    const fence = artifactFence(token.lang);
    // A streaming unclosed fence is still a code token in marked.
    if (!fence || !fenceClosed(token.raw)) continue;
    artifacts.push({
      id: `${messageId}:${artifacts.length}`,
      title: artifactTitle(fence, token.text, artifacts.length),
      language: fence.language,
      source: token.text,
    });
  }
  return artifacts;
}

/**
 * The artifact a click on a card opened, read back from the card `markdown.ts` wrote in place
 * of the artifact's code: its title, its language and its source, which the card keeps as text
 * as a code block keeps its code. Only `markdown.ts` writes these cards, after sanitization.
 */
export function artifactCardAction(
  target: EventTarget | null,
): { button: HTMLButtonElement; artifact: Artifact; mode: 'modal' | 'panel' } | undefined {
  if (!(target instanceof Element)) return;
  const button = target.closest('button.artifact-open, button.artifact-side');
  const card = button?.parentElement;
  if (!(button instanceof HTMLButtonElement) || !card?.matches('.artifact-card[data-language]'))
    return;
  const language = card.getAttribute('data-language');
  const title = card.querySelector(':scope > .artifact-open > span')?.textContent;
  const source = card.querySelector(':scope > pre > code')?.textContent;
  if ((language !== 'html' && language !== 'svg') || !title || source == null) return;
  return {
    button,
    artifact: { id: `card:${language}:${checksum(source)}`, title, language, source },
    mode: button.classList.contains('artifact-side') ? 'panel' : 'modal',
  };
}

// Tells artifacts apart for the viewer that shows one, which starts again when it changes.
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length.toString(36)}${(hash >>> 0).toString(36)}`;
}

export function artifactFilename(artifact: Artifact) {
  const base =
    artifact.title
      .replace(/[^\p{L}\p{N} ._-]/gu, '')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 80) || 'artifact';
  return base.toLowerCase().endsWith(`.${artifact.language}`)
    ? base
    : `${base}.${artifact.language}`;
}

// Native background workflows can finish with a short status after the parent
// already delivered the artifact. Preserve those parent-authored fences too.
export function messageArtifacts(message: Message): Artifact[] {
  if (message.role !== 'assistant') return [];
  const result: Artifact[] = [];
  const blocks = [
    ...message.blocks.filter((b) => b.type === 'markdown'),
    ...message.blocks.filter((b) => b.type === 'activity' && b.progress && !b.tool),
  ];
  for (const [index, block] of blocks.entries()) {
    for (const artifact of responseArtifacts(block.text, `${message.id}:${index}`)) {
      if (!result.some((a) => artifactKey(a) === artifactKey(artifact))) result.push(artifact);
    }
  }
  return result;
}
