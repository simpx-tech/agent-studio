import { z } from 'zod';

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** One installation's last `claude update`, reported by the desktop host. See docs/UPDATES.md. */
export const cliUpdateStatusSchema = z.object({
  environmentId: z.string().max(80),
  phase: z.enum(['checking', 'current', 'updated', 'busy', 'managed', 'blocked', 'failed']),
  version: z.string().max(40).optional(),
  previous: z.string().max(40).optional(),
  checkedAt: time.optional(),
  message: z.string().max(300).optional(),
});
export type CliUpdateStatus = z.infer<typeof cliUpdateStatusSchema>;
export const cliUpdatesSchema = z.object({
  automatic: z.boolean(),
  notice: z.string().max(300).optional(),
  statuses: z.array(cliUpdateStatusSchema).max(64),
});
export type CliUpdates = z.infer<typeof cliUpdatesSchema>;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What the last check of one installation found, in a sentence. */
export function cliUpdateSummary(status: CliUpdateStatus): string {
  const checked = status.checkedAt ? ` Checked ${clock(status.checkedAt)}.` : '';
  switch (status.phase) {
    case 'checking':
      return 'Checking for a newer Claude Code…';
    case 'current':
      return (status.message ?? 'Up to date.') + checked;
    case 'updated':
      return `Updated${status.previous ? ` from ${status.previous}` : ''} to ${status.version ?? 'a newer version'}${status.checkedAt ? ` at ${clock(status.checkedAt)}` : ''}.`;
    case 'busy':
    case 'managed':
    case 'blocked':
      return status.message ?? 'Agent Studio leaves this installation as it is.';
    case 'failed':
      return `The last update did not finish: ${status.message ?? 'Claude Code could not update.'}`;
  }
}

/** Updates that finished since the previous reading, by installation. */
export function newlyUpdated(previous: CliUpdates | undefined, next: CliUpdates): string[] {
  return next.statuses
    .filter(
      (status) =>
        status.phase === 'updated' &&
        !previous?.statuses.some(
          (old) =>
            old.environmentId === status.environmentId &&
            old.phase === 'updated' &&
            old.checkedAt === status.checkedAt,
        ),
    )
    .map((status) => status.environmentId);
}
