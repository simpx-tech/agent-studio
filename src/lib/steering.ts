import { z } from 'zod';

export const steeringInputSchema = z
  .object({
    id: z.string().uuid(),
    text: z
      .string()
      .min(1)
      .max(30000)
      .refine((v) => !!v.trim() && !v.includes('\0') && !v.trimStart().startsWith('/')),
  })
  .strict();
export const steeringReceiptSchema = steeringInputSchema.extend({
  runId: z.string().uuid(),
  sequence: z.number().int().min(1).max(8),
});
export const steeringSchema = z
  .array(steeringReceiptSchema)
  .max(8)
  .refine(
    (items) =>
      new Set(items.map((i) => i.id)).size === items.length &&
      items.reduce((n, i) => n + i.text.length, 0) <= 60000,
  );
export type SteeringInput = z.infer<typeof steeringInputSchema>;
export type SteeringReceipt = z.infer<typeof steeringReceiptSchema>;
export function mergeSteering(left: SteeringReceipt[] = [], right: SteeringReceipt[] = []) {
  const result = [...left];
  for (const item of right) {
    if (result.some((v) => v.id === item.id)) continue;
    const next = [...result, item].sort((a, b) => a.sequence - b.sequence);
    if (steeringSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}
export function steeringHistory(items: SteeringReceipt[] = []) {
  return items.length
    ? '\n\nUser steering accepted during this reply (earlier context):\n' +
        JSON.stringify(items.map(({ text }) => ({ text })))
    : '';
}
