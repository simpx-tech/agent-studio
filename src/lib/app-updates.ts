import { z } from 'zod';

const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Desktop update state reported by the native updater. See docs/UPDATES.md. */
export const appUpdateStatusSchema = z.object({
  currentVersion: z.string().max(64),
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
  version: z.string().max(64).optional(),
  notes: z.string().max(4000).optional(),
  downloaded: size.optional(),
  total: size.optional(),
  checkedAt: size.optional(),
  message: z.string().max(300).optional(),
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
      return status.message ?? 'Automatic updates are unavailable for this copy.';
    case 'idle':
      return 'Agent Studio checks for updates shortly after it starts.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'Agent Studio is up to date.';
    case 'downloading': {
      const progress = updateProgress(status);
      return `Downloading ${version}${progress === undefined ? '…' : ` (${progress}%)`}`;
    }
    case 'ready':
      return `${status.version ? `Version ${status.version}` : 'An update'} is ready. Restart Agent Studio to finish updating.`;
    case 'installing':
      return `Installing ${version}. Agent Studio will restart.`;
    case 'failed':
      return 'The last update attempt did not finish.';
  }
}

/** Why Restart to update is unavailable right now, if it is. */
export function restartBlocked(status: AppUpdateStatus | undefined): string | undefined {
  if (status?.phase === 'installing') return 'Installing the update…';
  if (status?.phase !== 'ready') return 'No update is ready to install.';
  if (status.repliesRunning) return 'Restart after replies running on this computer finish.';
  return undefined;
}
