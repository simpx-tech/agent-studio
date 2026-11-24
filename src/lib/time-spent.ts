import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Where a reply's time went, as the computer that ran it measured it while it ran
 * (src-tauri/src/protocol/time_spent.rs): milliseconds by what the reply waited on, each moment
 * counted once. Kinds are plain names, so one a later release adds reaches this one, which shows
 * it with the rest (src/lib/time-report.ts). Times, counts, note ids and the titles of the plan's
 * steps, which the reply saves anyway: nothing it said or ran.
 */
export const timeSpentSchema = z.object({
  version: z.number().int().positive(),
  revision: count,
  runId: z.string().uuid(),
  spent: z.record(z.string(), count),
  // Requests the model answered, and those the CLI sent again after the provider failed them.
  requests: count.optional(),
  retries: count.optional(),
  // The same time in the order it passed: for each stretch its kind's place in `kinds`, then its
  // milliseconds. Stretches too short to show on a chart are joined with their neighbours.
  timeline: z.object({ kinds: z.array(z.string()), runs: z.array(count) }).optional(),
  // From `at` milliseconds into the reply, this step of its plan was in progress, or none was.
  steps: z.array(z.object({ at: count, title: z.string().optional() })).optional(),
  // At `at`, the model began the note with this id, one of the reply's progress comments.
  notes: z.array(z.object({ at: count, id: z.string() })).optional(),
});
export type TimeSpent = z.infer<typeof timeSpentSchema>;

/** The later of two records of a reply's time. A running reply reports it about once a minute. */
export function latestTimeSpent(left?: TimeSpent, right?: TimeSpent): TimeSpent | undefined {
  if (!left || !right) return left ?? right;
  return right.revision > left.revision ? right : left;
}
