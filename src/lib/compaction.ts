import { z } from 'zod';

export const compactionSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'complete']),
  trigger: z.enum(['manual', 'auto', 'unknown']),
  preTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  postTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  usageRevision: z.number().int().nonnegative().optional(),
  // The calls, comments and reasoning its reply had recorded before it began, which places it
  // among them in Work history. Markers saved before 2026-10-12 lack it and follow that work.
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const compactionsSchema = z.array(compactionSchema);
export type Compaction = z.infer<typeof compactionSchema>;
// A device that follows a reply through the relay can miss entries the job no longer carries,
// so it counts fewer before a marker than the computer that ran the reply: the larger place is
// that computer's, and a copy without one, as an older relay returns it, removes none.
const place = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.max(a, b));
export function mergeCompactions(left: Compaction[] = [], right: Compaction[] = []) {
  const result = [...left];
  for (const next of right) {
    const i = result.findIndex((c) => c.id === next.id);
    if (i >= 0) {
      const kept = next.revision > result[i].revision ? next : result[i];
      const after = place(result[i].after, next.after);
      result[i] = after === kept.after ? kept : { ...kept, after };
    } else result.push(next);
  }
  return result;
}

export function compactionLabel(c: Compaction, status: string) {
  if (c.status === 'running')
    return status === 'running' ? 'Compacting context…' : 'Compaction was not confirmed';
  return c.trigger === 'auto' ? 'Context compacted automatically' : 'Context compacted';
}

/** The sizes the provider reported for a compaction, or nothing when it reported none. */
export function compactionTokens(c: Compaction) {
  if (c.preTokens == null) return '';
  const after = c.postTokens != null ? ` → ${c.postTokens.toLocaleString()} after` : '';
  return `${c.preTokens.toLocaleString()} tokens before${after}`;
}
