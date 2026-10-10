import { z } from 'zod';

export const reasoningBlockSchema = z.object({
  type: z.literal('reasoning'),
  id: z
    .string()
    .min(1)
    .refine((id) => !/[\u0000-\u001f\u007f]/.test(id)),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Kept whole. Computers before 2026-10-10 cut it at 16,000 characters, marking it truncated.
  text: z.string().min(1),
  truncated: z.boolean(),
});
export type ReasoningBlock = z.infer<typeof reasoningBlockSchema>;

export function mergeReasoningBlocks(left: ReasoningBlock[], right: ReasoningBlock[]) {
  const result = [...left];
  for (const block of right) {
    const index = result.findIndex((b) => b.id === block.id);
    if (index >= 0) {
      if (block.revision > result[index].revision) result[index] = block;
    } else result.push(block);
  }
  return result;
}
