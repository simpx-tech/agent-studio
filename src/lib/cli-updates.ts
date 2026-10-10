import { z } from 'zod';

/** The CLIs the desktop host keeps current, with the names Settings shows. */
export const updatedClis = [
  { provider: 'claude', name: 'Claude Code' },
  { provider: 'codex', name: 'Codex' },
] as const;
export type UpdatedCli = (typeof updatedClis)[number]['provider'];
export const cliName = (provider: UpdatedCli) =>
  updatedClis.find((cli) => cli.provider === provider)!.name;

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** One installation's last update check, reported by the desktop host. See docs/UPDATES.md. */
export const cliUpdateStatusSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  environmentId: z.string(),
  phase: z.enum([
    'checking',
    'current',
    'updated',
    'waiting',
    'busy',
    'managed',
    'blocked',
    'failed',
  ]),
  version: z.string().optional(),
  previous: z.string().optional(),
  checkedAt: time.optional(),
  message: z.string().optional(),
});
export type CliUpdateStatus = z.infer<typeof cliUpdateStatusSchema>;
export const cliUpdatesSchema = z.object({
  automatic: z.object({ claude: z.boolean(), codex: z.boolean() }),
  notice: z.string().optional(),
  statuses: z.array(cliUpdateStatusSchema),
});
export type CliUpdates = z.infer<typeof cliUpdatesSchema>;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What the last check of one installation found, in a sentence. */
export function cliUpdateSummary(status: CliUpdateStatus): string {
  const name = cliName(status.provider);
  const checked = status.checkedAt ? ` Checked ${clock(status.checkedAt)}.` : '';
  switch (status.phase) {
    case 'checking':
      return `Checking for a newer ${name}…`;
    case 'current':
      return (status.message ?? 'Up to date.') + checked;
    case 'updated':
      return `Updated${status.previous ? ` from ${status.previous}` : ''} to ${status.version ?? 'a newer version'}${status.checkedAt ? ` at ${clock(status.checkedAt)}` : ''}.`;
    case 'waiting':
    case 'busy':
    case 'managed':
    case 'blocked':
      return status.message ?? 'Agent Studio leaves this installation as it is.';
    case 'failed':
      return `The last update did not finish: ${status.message ?? `${name} could not update.`}`;
  }
}

/** Updates that finished since the previous reading, by CLI and installation. */
export function newlyUpdated(
  previous: CliUpdates | undefined,
  next: CliUpdates,
): { provider: UpdatedCli; environmentId: string }[] {
  return next.statuses
    .filter(
      (status) =>
        status.phase === 'updated' &&
        !previous?.statuses.some(
          (old) =>
            old.provider === status.provider &&
            old.environmentId === status.environmentId &&
            old.phase === 'updated' &&
            old.checkedAt === status.checkedAt,
        ),
    )
    .map(({ provider, environmentId }) => ({ provider, environmentId }));
}
