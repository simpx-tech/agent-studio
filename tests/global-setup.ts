import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Where tests note a copy of a conversation that differs from its live data
// (tests/desktop-helper.ts), which tests/global-teardown.ts reads after the run.
export default function globalSetup() {
  const log = join(tmpdir(), `agent-studio-chat-snapshots-${process.pid}.log`);
  rmSync(log, { force: true });
  process.env.STUDIO_SNAPSHOT_LOG = log;
}
