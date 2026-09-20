import { z } from 'zod';

export const proposedPlanSchema = z.object({
  id: z.string().min(1).max(240),
  revision: z.number().int().nonnegative(),
  text: z.string().max(128_000), // 64K Unicode scalar values from the native decoder.
  complete: z.boolean(),
  truncated: z.boolean(),
});
export const proposedPlansSchema = z
  .array(proposedPlanSchema)
  .max(8)
  .refine((items) => new Set(items.map((p) => p.id)).size === items.length);
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;
export function mergeProposedPlans(left: ProposedPlan[] = [], right: ProposedPlan[] = []) {
  const result = [...left];
  for (const next of right) {
    const i = result.findIndex((p) => p.id === next.id);
    if (i >= 0) {
      if (!result[i].complete && next.revision > result[i].revision) result[i] = next;
    } else if (result.length < 8) result.push(next);
  }
  return result;
}
export function proposedPlanHistory(plans: ProposedPlan[] = []) {
  const completed = plans.filter((p) => p.complete && !p.truncated && p.text.trim());
  return completed.length
    ? '\n\nPreviously proposed plans (context only, not approval to execute):\n' +
        JSON.stringify(completed.map((p) => p.text))
    : '';
}
