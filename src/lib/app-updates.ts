import { z } from 'zod';

const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Desktop update state reported by the native updater. See docs/UPDATES.md. */
export const appUpdateStatusSchema = z.object({
  currentVersion: z.string(),
  phase: z.enum([
    'unavailable',
    'idle',
    'checking',
    'current',
    'downloading',
    'ready',
    'installing',
    'failed',
  ]),
  version: z.string().optional(),
  notes: z.string().optional(),
  downloaded: size.optional(),
  total: size.optional(),
  checkedAt: size.optional(),
  message: z.string().optional(),
  repliesRunning: z.boolean(),
});
export type AppUpdateStatus = z.infer<typeof appUpdateStatusSchema>;

/** Whole download percentage, or undefined while the size is unknown. */
export function updateProgress(status: AppUpdateStatus): number | undefined {
  if (!status.total || status.downloaded === undefined) return undefined;
  return Math.min(100, Math.floor((status.downloaded / status.total) * 100));
}

/** A short description of the updater state for Settings. */
export function updateSummary(status: AppUpdateStatus): string {
  const version = status.version ? `version ${status.version}` : 'the update';
  switch (status.phase) {
    case 'unavailable':
      return status.message ?? 'Updates unavailable.';
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'Up to date.';
    case 'downloading': {
      const progress = updateProgress(status);
      return `Downloading ${version}${progress === undefined ? '…' : ` (${progress}%)`}`;
    }
    case 'ready':
      return `${status.version ? `Version ${status.version}` : 'An update'} is ready.`;
    case 'installing':
      return `Installing ${version}…`;
    case 'failed':
      return 'Update failed.';
  }
}

/** Why Restart to update is unavailable right now, if it is. */
export function restartBlocked(status: AppUpdateStatus | undefined): string | undefined {
  if (status?.phase === 'installing') return 'Installing the update…';
  if (status?.phase !== 'ready') return 'No update is ready to install.';
  if (status.repliesRunning) return 'Restart after replies running on this computer finish.';
  return undefined;
}
