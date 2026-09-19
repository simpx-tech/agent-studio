import { z } from 'zod';

export const compactionSchema = z.object({
  id: z.string().min(1).max(240),
  revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'complete']),
  trigger: z.enum(['manual', 'auto', 'unknown']),
  preTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  postTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  usageRevision: z.number().int().nonnegative().optional(),
});
export const compactionsSchema = z.array(compactionSchema).max(32);
export type Compaction = z.infer<typeof compactionSchema>;
export function mergeCompactions(left: Compaction[] = [], right: Compaction[] = []) {
  const result = [...left];
  for (const next of right) {
    const i = result.findIndex((c) => c.id === next.id);
    if (i >= 0) {
      if (next.revision > result[i].revision) result[i] = next;
    } else if (result.length < 32) result.push(next);
  }
  return result;
}

export function compactionLabel(c: Compaction, status: string) {
  if (c.status === 'running')
    return status === 'running' ? 'Compacting context…' : 'Compaction was not confirmed';
  return c.trigger === 'auto' ? 'Context compacted automatically' : 'Context compacted';
}
