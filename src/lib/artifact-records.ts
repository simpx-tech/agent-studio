import { z } from 'zod';
import { visualizationSchema } from './visualizations.ts';

/**
 * An artifact page a reply showed with the show_artifact tool (requested 2026-10-14): the agent
 * wrote the page to a file, the computer running the conversation read it whole, and the reply
 * keeps its exact source, shown as a card at its <!-- artifact:ID --> marker. Showing an id
 * again replaces it with the next revision. Its id, title and source follow the rules of a
 * visualization's. Kept apart from artifacts.ts, which reads Markdown, so the relay can load it.
 */
export const artifactRecordSchema = visualizationSchema.extend({
  language: z.enum(['html', 'svg']),
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export const artifactRecordsSchema = z
  .array(artifactRecordSchema)
  .refine((items) => new Set(items.map((a) => a.id)).size === items.length);

/** Each artifact at its latest revision, in the order they were first shown. */
export function mergeArtifactRecords(
  left: ArtifactRecord[] = [],
  right: ArtifactRecord[] = [],
): ArtifactRecord[] {
  const result = [...left];
  for (const artifact of right) {
    const index = result.findIndex((a) => a.id === artifact.id);
    if (index >= 0 && result[index].revision >= artifact.revision) continue;
    const next = [...result];
    if (index >= 0) next[index] = artifact;
    else next.push(artifact);
    if (artifactRecordsSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}
