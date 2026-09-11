import { marked } from 'marked';
import type { Message } from './domain';

export type Artifact = {
  id: string;
  title: string;
  language: 'html' | 'svg';
  source: string;
  visualization?: boolean;
  revision?: number;
};
export const maxArtifactBytes = 512_000;

// Only complete, explicitly labelled output blocks become artifacts. Never read
// provider tool arguments or arbitrary local paths to manufacture a preview.
export function responseArtifacts(text: string, messageId: string): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const token of marked.lexer(text)) {
    if (token.type !== 'code' || artifacts.length >= 12) continue;
    const language = token.lang?.split(/\s/)[0]?.toLowerCase();
    if (language !== 'html' && language !== 'svg') continue;
    // A streaming unclosed fence is still a code token in marked.
    const fence = token.raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence || !new RegExp(`\\n {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(token.raw))
      continue;
    if (new TextEncoder().encode(token.text).length > maxArtifactBytes) continue;
    const name = token.lang
      ?.slice(language.length)
      .trim()
      .replace(/^title=/, '')
      .replace(/^['"]|['"]$/g, '');
    const htmlTitle = token.text.match(/<title[^>]*>([^<]{1,100})<\/title>/i)?.[1];
    artifacts.push({
      id: `${messageId}:${artifacts.length}`,
      title: (
        name ||
        htmlTitle ||
        `${language.toUpperCase()} artifact ${artifacts.length + 1}`
      ).slice(0, 100),
      language,
      source: token.text,
    });
  }
  return artifacts;
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
      if (!result.some((a) => a.language === artifact.language && a.source === artifact.source))
        result.push(artifact);
      if (result.length >= 12) return result;
    }
  }
  return result;
}
