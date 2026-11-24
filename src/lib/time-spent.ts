import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Where a reply's time went, as the computer that ran it measured it while it ran
 * (src-tauri/src/protocol/time_spent.rs): milliseconds by what the reply waited on, each moment
 * counted once. Kinds are plain names, so one a later release adds reaches this one, which shows
 * it with the rest (src/lib/time-report.ts). Only times and counts: nothing a reply said or ran.
 */
export const timeSpentSchema = z.object({
  version: z.number().int().positive(),
  revision: count,
  runId: z.string().uuid(),
  spent: z.record(z.string(), count),
  // Requests the model answered, and those the CLI sent again after the provider failed them.
  requests: count.optional(),
  retries: count.optional(),
});
export type TimeSpent = z.infer<typeof timeSpentSchema>;

/** The later of two records of a reply's time. A running reply reports it about once a minute. */
export function latestTimeSpent(left?: TimeSpent, right?: TimeSpent): TimeSpent | undefined {
  if (!left || !right) return left ?? right;
  return right.revision > left.revision ? right : left;
}
