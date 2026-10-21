import { z } from 'zod';

/**
 * An artifact a Claude reply published to claude.ai, or opened there, with Claude Code's own
 * Artifact tools (requested 2026-10-21): its id, link and title as the CLI reported them, never
 * the page. The reply shows it as a card that opens it on claude.ai, and keeps each artifact at
 * its latest revision (`src-tauri/src/providers/published_artifacts.rs`). Kept apart from the
 * window's modules so the relay can load it.
 */
// claude.ai's own link of an artifact: a short id, or the full one under /code.
const artifactUrl = z
  .string()
  .regex(
    /^https:\/\/claude\.ai\/(?:artifact\/[1-9A-HJ-NP-Za-km-z]{22}|code\/artifact\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
export const publishedArtifactSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: artifactUrl,
  title: z
    .string()
    .min(1)
    .refine((s) => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s)),
});
export type PublishedArtifact = z.infer<typeof publishedArtifactSchema>;
export const publishedArtifactsSchema = z
  .array(publishedArtifactSchema)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length);

/** Each artifact at its latest revision, in the order the reply first published or opened it. */
export function mergePublishedArtifacts(
  left: PublishedArtifact[] = [],
  right: PublishedArtifact[] = [],
): PublishedArtifact[] {
  const result = [...left];
  for (const item of right) {
    const index = result.findIndex((known) => known.id === item.id);
    if (index < 0) result.push(item);
    else if (result[index].revision < item.revision) result[index] = item;
  }
  return result;
}

/** The artifacts a reply published, as a new session of the conversation reads that reply. */
export function publishedHistory(items: PublishedArtifact[] = []): string {
  return items.map((item) => `\n\n[Artifact on claude.ai: ${item.title} — ${item.url}]`).join('');
}
