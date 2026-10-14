import { existsSync, readFileSync, rmSync } from 'node:fs';

// Fails the run when a test's page made a copy of a conversation that differs from a full parse
// of it (src/lib/chat-snapshots.ts): something edited a message or a block in place, or changed a
// message without saying so, and saves and syncs would have missed that change.
export default function globalTeardown() {
  const log = process.env.STUDIO_SNAPSHOT_LOG;
  if (!log || !existsSync(log)) return;
  const found = readFileSync(log, 'utf8').trim();
  rmSync(log, { force: true });
  if (found)
    throw new Error(
      `Copies of conversations differed from their live data:\n${found.split('\n').slice(0, 20).join('\n')}`,
    );
}
