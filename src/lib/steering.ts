import { z } from 'zod';

export const steeringInputSchema = z
  .object({
    id: z.string().uuid(),
    text: z
      .string()
      .min(1)
      .refine((v) => !!v.trim() && !v.includes('\0') && !v.trimStart().startsWith('/')),
  })
  .strict();
export const steeringReceiptSchema = steeringInputSchema.extend({
  runId: z.string().uuid(),
  sequence: z.number().int().min(1),
});
export const steeringSchema = z
  .array(steeringReceiptSchema)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length);
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
/**
 * Where an accepted steer arrived in its reply: `after` that many of the calls, comments, notes
 * and reasoning blocks the reply had recorded, and `at` the time its computer confirmed it. The
 * reply's work divides there, with the steer shown between the two parts as a message of the
 * user's own. Places are kept beside the receipts, whose shape releases before 2026-10-13
 * validate strictly: those drop this list and keep every receipt.
 */
export const steeringPlaceSchema = z.object({
  id: z.string().uuid(),
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: z.string().optional(),
});
export const steeringPlacesSchema = z.array(steeringPlaceSchema);
export type SteeringPlace = z.infer<typeof steeringPlaceSchema>;
/**
 * The places two copies of a reply hold, one per steer in the order of their ids, so copies
 * that merged the same places are equal. Where both hold one, the larger count is kept: a device
 * that follows a reply through the relay can have missed entries the job no longer carries, so
 * it counts fewer before a steer than the computer that ran the reply. A copy without a place,
 * as an older relay returns it, removes none.
 */
export function mergeSteeringPlaces(left: SteeringPlace[] = [], right: SteeringPlace[] = []) {
  const places = new Map<string, SteeringPlace>();
  for (const next of [...left, ...right]) {
    const held = places.get(next.id);
    const after = Math.max(held?.after ?? 0, next.after);
    const at =
      held?.at && next.at ? (held.at < next.at ? held.at : next.at) : (held?.at ?? next.at);
    places.set(next.id, { id: next.id, after, ...(at ? { at } : {}) });
  }
  return [...places.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** A steer with where it arrived in its reply, when a window recorded that. */
export type PlacedSteering = SteeringReceipt & { after?: number; at?: string };
export function placedSteering(
  receipts: SteeringReceipt[] = [],
  places: SteeringPlace[] = [],
): PlacedSteering[] {
  return receipts.map((receipt) => {
    const place = places.find((p) => p.id === receipt.id);
    return place
      ? { ...receipt, after: place.after, ...(place.at ? { at: place.at } : {}) }
      : receipt;
  });
}
export function steeringHistory(items: SteeringReceipt[] = []) {
  return items.length
    ? '\n\nUser steering accepted during this reply (earlier context):\n' +
        JSON.stringify(items.map(({ text }) => ({ text })))
    : '';
}
