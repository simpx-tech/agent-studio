import { createHmac } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const sessionSchema = z.object({
  actor: z.string().uuid(),
  expires: z.number().int().nonnegative(),
  secure: z.boolean(),
});
const diskSchema = z.object({
  version: z.literal(1),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  sessions: z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}$/), sessionSchema])).max(1000),
});
type Session = z.infer<typeof sessionSchema>;

// Store only keyed digests of random session IDs, outside the public build and
// workspace exports. Neither browser cookies nor the pairing key go on disk.
export function sessionStore(directory: string, token: string, now: () => number) {
  const file = join(directory, 'browser-sessions.json');
  const digest = (id: string) =>
    createHmac('sha256', token).update(`browser-session:${id}`).digest('hex');
  const keyId = digest('key-version-1');
  let sessions = new Map<string, Session>();
  function save(next: Map<string, Session>) {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, keyId, sessions: [...next] }), {
      mode: 0o600,
    });
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    sessions = next;
  }
  try {
    if (statSync(file).size > 256_000) throw new Error('Session file exceeds its limit.');
    const stored = diskSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (stored.keyId === keyId)
      sessions = new Map(stored.sessions.filter(([, session]) => session.expires > now()));
    // Persist rotation immediately, so switching back cannot revive old sessions.
    else save(sessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Browser session data is unreadable; preserved without overwriting.');
  }
  return {
    get: (id: string) => sessions.get(digest(id)),
    size: () => [...sessions.values()].filter((session) => session.expires > now()).length,
    replace(oldId: string, id?: string, session?: Session) {
      const next = new Map([...sessions].filter(([, value]) => value.expires > now()));
      next.delete(digest(oldId));
      if (id && session) next.set(digest(id), session);
      save(next);
    },
  };
}
