import { z } from 'zod';

export const maxReasoningBlocks = 64;
export const reasoningBlockSchema = z.object({
  type: z.literal('reasoning'),
  id: z
    .string()
    .min(1)
    .max(240)
    .refine((id) => !/[\u0000-\u001f\u007f]/.test(id)),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Native decoding caps at 16,000 Unicode scalars (up to 32,000 JS code units).
  text: z.string().min(1).max(32000),
  truncated: z.boolean(),
});
export type ReasoningBlock = z.infer<typeof reasoningBlockSchema>;

export function mergeReasoningBlocks(left: ReasoningBlock[], right: ReasoningBlock[]) {
  const result = [...left];
  for (const block of right) {
    const index = result.findIndex((b) => b.id === block.id);
    if (index >= 0) {
      if (block.revision > result[index].revision) result[index] = block;
    } else if (result.length < maxReasoningBlocks) result.push(block);
  }
  return result;
}
