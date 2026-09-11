import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  tokenHash: hex,
  sessionSecret: hex,
});
const registrySchema = z
  .object({
    version: z.literal(1),
    workspaces: z.array(entrySchema).max(100),
  })
  .refine(
    (value) => new Set(value.workspaces.map((entry) => entry.id)).size === value.workspaces.length,
  );
type Entry = z.infer<typeof entrySchema>;
type Registry = z.infer<typeof registrySchema>;
export type RelayWorkspace = {
  id: string;
  name: string;
  directory: string;
  secret: string;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const publicEntry = ({ id, name, enabled, createdAt }: Entry) => ({ id, name, enabled, createdAt });

function readRegistry(directory: string): Registry {
  const file = join(directory, 'workspaces.json');
  try {
    if (statSync(file).size > 128_000) throw new Error();
    return registrySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: [] };
    throw new Error('Workspace registry is unreadable; preserved without overwriting.');
  }
}

function updateRegistry<T>(directory: string, change: (registry: Registry) => T): T {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'workspaces.lock');
  let lockFd: number;
  try {
    lockFd = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error('Workspace administration is locked. Wait for the other command to finish.');
  }
  try {
    const registry = readRegistry(directory);
    const result = change(registry);
    registrySchema.parse(registry);
    const file = join(directory, 'workspaces.json');
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(registry), { mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    return result;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

// Administrative functions are local-only. Plain pairing keys are returned only
// on creation/rotation, never persisted or exposed in list/state responses.
export function createWorkspace({
  directory,
  name,
  now = Date.now,
}: {
  directory: string;
  name: string;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => {
    if (registry.workspaces.length >= 100)
      throw new Error('The server supports at most 100 additional workspaces.');
    const token = randomBytes(32).toString('base64url');
    const entry = entrySchema.parse({
      id: randomUUID(),
      name,
      enabled: true,
      createdAt: now(),
      tokenHash: hash(token),
      sessionSecret: randomBytes(32).toString('hex'),
    });
    if (
      registry.workspaces.some(
        (item) => item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase(),
      )
    )
      throw new Error('A workspace with that name already exists.');
    registry.workspaces.push(entry);
    return { workspace: publicEntry(entry), token };
  });
}

export function listWorkspaces(directory: string) {
  return readRegistry(directory).workspaces.map(publicEntry);
}

export function rotateWorkspace({
  directory,
  id,
}: {
  directory: string;
  id: string;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => {
    const entry = registry.workspaces.find((item) => item.id === id);
    if (!entry) throw new Error('Workspace not found. Use list to find its ID.');
    const token = randomBytes(32).toString('base64url');
    entry.tokenHash = hash(token);
    entry.sessionSecret = randomBytes(32).toString('hex');
    entry.enabled = true;
    return { workspace: publicEntry(entry), token };
  });
}

export function disableWorkspace({
  directory,
  id,
}: {
  directory: string;
  id: string;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => {
    const entry = registry.workspaces.find((item) => item.id === id);
    if (!entry) throw new Error('Workspace not found. Use list to find its ID.');
    entry.enabled = false;
    entry.sessionSecret = randomBytes(32).toString('hex');
    return publicEntry(entry);
  });
}

export function workspaceRegistry(directory: string, ownerToken: string) {
  const owner: RelayWorkspace = { id: 'owner', name: 'Owner', directory, secret: ownerToken };
  function entries() {
    return readRegistry(directory).workspaces;
  }
  const workspace = (entry: Entry): RelayWorkspace => ({
    id: entry.id,
    name: entry.name,
    directory: join(directory, 'workspaces', entry.id),
    secret: entry.sessionSecret,
  });
  return {
    owner,
    list() {
      return entries()
        .filter((entry) => entry.enabled)
        .map(workspace);
    },
    authenticate(token: string): RelayWorkspace | undefined {
      if (!token || token.length > 4096) return undefined;
      // Read even for the owner: a broken registry must fail closed.
      const current = entries();
      const digest = hash(token);
      if (equal(digest, hash(ownerToken))) return owner;
      const entry = current.find((item) => item.enabled && equal(digest, item.tokenHash));
      return entry ? workspace(entry) : undefined;
    },
    get(id: string): RelayWorkspace | undefined {
      const current = entries();
      if (id === 'owner') return owner;
      const entry = current.find((item) => item.id === id && item.enabled);
      return entry ? workspace(entry) : undefined;
    },
    active(candidate: RelayWorkspace) {
      const current = this.get(candidate.id);
      return !!current && current.secret === candidate.secret;
    },
  };
}
