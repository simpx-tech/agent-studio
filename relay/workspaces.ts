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
export const workspaceRoleSchema = z.enum(['admin', 'member']);
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const workspaceAdminInput = z
  .object({ name: workspaceNameSchema, role: workspaceRoleSchema })
  .strict();
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
const ownerSchema = z.object({ name: workspaceNameSchema, role: workspaceRoleSchema });
const entrySchema = z.object({
  id: z.string().uuid(),
  name: workspaceNameSchema,
  role: workspaceRoleSchema.default('member'),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  tokenHash: hex,
  sessionSecret: hex,
});
const legacyRegistrySchema = z
  .object({
    version: z.literal(1),
    owner: ownerSchema.default({ name: 'Owner', role: 'admin' }),
    workspaces: z.array(entrySchema).max(100),
  })
  .refine(
    (value) => new Set(value.workspaces.map((entry) => entry.id)).size === value.workspaces.length,
  )
  .refine(
    (value) =>
      value.owner.role === 'admin' ||
      value.workspaces.some((entry) => entry.enabled && entry.role === 'admin'),
  );
const registrySchema = z
  .object({
    version: z.literal(2),
    owner: ownerSchema,
    workspaces: z.array(entrySchema.extend({ role: workspaceRoleSchema })).max(100),
  })
  .refine(
    (value) => new Set(value.workspaces.map((entry) => entry.id)).size === value.workspaces.length,
  )
  .refine((value) => {
    const admins = value.workspaces.filter((entry) => entry.role === 'admin');
    return (
      Number(value.owner.role === 'admin') + admins.length === 1 &&
      admins.every((entry) => entry.enabled)
    );
  });
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
const publicEntry = ({ id, name, role, enabled, createdAt }: Entry) => ({
  id,
  name,
  role,
  enabled,
  createdAt,
});
const publicOwner = (registry: Registry) => ({
  id: 'owner',
  ...registry.owner,
  enabled: true,
  createdAt: null,
});
const managementList = (registry: Registry) => [
  publicOwner(registry),
  ...registry.workspaces.map(publicEntry),
];

export class WorkspaceAdminError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function retainAdministrator(registry: Registry) {
  if (!registrySchema.safeParse(registry).success)
    throw new WorkspaceAdminError(
      409,
      'final_admin',
      'Keep exactly one enabled administrator workspace. Transfer administration to another workspace first.',
    );
}
function assignAdministrator(registry: Registry, id: string) {
  if (id !== 'owner' && !findEntry(registry, id).enabled)
    throw new WorkspaceAdminError(
      409,
      'workspace_disabled',
      'Enable this workspace before transferring administration to it.',
    );
  registry.owner.role = id === 'owner' ? 'admin' : 'member';
  for (const entry of registry.workspaces) entry.role = entry.id === id ? 'admin' : 'member';
}
function findEntry(registry: Registry, id: string) {
  const entry = registry.workspaces.find((item) => item.id === id);
  if (!entry)
    throw new WorkspaceAdminError(
      404,
      'workspace_not_found',
      'Workspace not found. Refresh the workspace list.',
    );
  return entry;
}
function uniqueName(registry: Registry, name: string, id?: string) {
  const normalized = name.toLocaleLowerCase();
  if (
    managementList(registry).some(
      (entry) => entry.id !== id && entry.name.toLocaleLowerCase() === normalized,
    )
  )
    throw new WorkspaceAdminError(
      409,
      'workspace_name_exists',
      'A workspace with that name already exists.',
    );
}
function createEntry(registry: Registry, name: string, role: WorkspaceRole, now: () => number) {
  if (role === 'admin')
    throw new WorkspaceAdminError(
      409,
      'create_member_first',
      'Create a member workspace and save its key before transferring administration to it.',
    );
  if (registry.workspaces.length >= 100)
    throw new WorkspaceAdminError(
      409,
      'workspace_limit',
      'The server supports at most 100 additional workspaces.',
    );
  const token = randomBytes(32).toString('base64url');
  const entry = entrySchema.parse({
    id: randomUUID(),
    name,
    role,
    enabled: true,
    createdAt: now(),
    tokenHash: hash(token),
    sessionSecret: randomBytes(32).toString('hex'),
  });
  uniqueName(registry, entry.name);
  registry.workspaces.push(entry);
  return { workspace: publicEntry(entry), token };
}
function editEntry(registry: Registry, id: string, name?: string, role?: WorkspaceRole) {
  const entry = id === 'owner' ? registry.owner : findEntry(registry, id);
  if (name !== undefined) {
    const nextName = workspaceNameSchema.parse(name);
    if (nextName !== entry.name) uniqueName(registry, nextName, id);
    entry.name = nextName;
  }
  if (role !== undefined) {
    const nextRole = workspaceRoleSchema.parse(role);
    if (nextRole === 'admin') assignAdministrator(registry, id);
    else entry.role = nextRole;
  }
  retainAdministrator(registry);
  return id === 'owner' ? publicOwner(registry) : publicEntry(findEntry(registry, id));
}
function protectOwner(id: string) {
  if (id === 'owner')
    throw new WorkspaceAdminError(
      409,
      'workspace_protected',
      'The owner pairing key is managed through the server environment.',
    );
}
function rotateEntry(registry: Registry, id: string) {
  protectOwner(id);
  const entry = findEntry(registry, id);
  const token = randomBytes(32).toString('base64url');
  entry.tokenHash = hash(token);
  entry.sessionSecret = randomBytes(32).toString('hex');
  entry.enabled = true;
  return { workspace: publicEntry(entry), token };
}
function disableEntry(registry: Registry, id: string) {
  protectOwner(id);
  const entry = findEntry(registry, id);
  entry.enabled = false;
  entry.sessionSecret = randomBytes(32).toString('hex');
  retainAdministrator(registry);
  return publicEntry(entry);
}

function readRegistry(directory: string): Registry {
  const file = join(directory, 'workspaces.json');
  try {
    if (statSync(file).size > 128_000) throw new Error();
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1) return registrySchema.parse(value);
    const legacy = legacyRegistrySchema.parse(value);
    // Preserve the owner's authority when present; otherwise retain the oldest
    // enabled admin (ID breaks timestamp ties), and demote every other workspace.
    const adminId =
      legacy.owner.role === 'admin'
        ? 'owner'
        : legacy.workspaces
            .filter((entry) => entry.enabled && entry.role === 'admin')
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0].id;
    const registry: Registry = { ...legacy, version: 2 };
    assignAdministrator(registry, adminId);
    return registrySchema.parse(registry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 2, owner: { name: 'Owner', role: 'admin' }, workspaces: [] };
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

// These local administrative helpers share their locked mutations with the API.
// Plain keys are returned only on creation/rotation and never persisted.
export function createWorkspace({
  directory,
  name,
  role = 'member',
  now = Date.now,
}: {
  directory: string;
  name: string;
  role?: WorkspaceRole;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => createEntry(registry, name, role, now));
}

export function listWorkspaces(directory: string) {
  return readRegistry(directory).workspaces.map(publicEntry);
}
export function listManagedWorkspaces(directory: string) {
  return managementList(readRegistry(directory));
}
export function editWorkspace({
  directory,
  id,
  name,
  role,
}: {
  directory: string;
  id: string;
  name?: string;
  role?: WorkspaceRole;
}) {
  return updateRegistry(directory, (registry) => editEntry(registry, id, name, role));
}

export function rotateWorkspace({
  directory,
  id,
}: {
  directory: string;
  id: string;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => rotateEntry(registry, id));
}

export function disableWorkspace({
  directory,
  id,
}: {
  directory: string;
  id: string;
  now?: () => number;
}) {
  return updateRegistry(directory, (registry) => disableEntry(registry, id));
}

export function workspaceRegistry(directory: string, ownerToken: string) {
  // Persist legacy role consolidation before serving any authenticated request.
  updateRegistry(directory, () => {});
  const owner = (registry: Registry): RelayWorkspace => ({
    id: 'owner',
    name: registry.owner.name,
    directory,
    secret: ownerToken,
  });
  function entries() {
    return readRegistry(directory).workspaces;
  }
  const workspace = (entry: Entry): RelayWorkspace => ({
    id: entry.id,
    name: entry.name,
    directory: join(directory, 'workspaces', entry.id),
    secret: entry.sessionSecret,
  });
  function identity(registry: Registry, candidate: RelayWorkspace) {
    if (candidate.id === 'owner' && candidate.secret === ownerToken) return publicOwner(registry);
    const entry = registry.workspaces.find(
      (item) => item.id === candidate.id && item.enabled && item.sessionSecret === candidate.secret,
    );
    if (!entry)
      throw new WorkspaceAdminError(
        401,
        'workspace_revoked',
        'Workspace access was revoked. Pair this device again.',
      );
    return publicEntry(entry);
  }
  function administrative<T>(
    candidate: RelayWorkspace,
    sessionActive: () => boolean,
    mutate: (registry: Registry) => T,
  ) {
    return updateRegistry(directory, (registry) => {
      // Recheck inside the exclusive mutation lock, including after body reads.
      if (!sessionActive())
        throw new WorkspaceAdminError(
          401,
          'workspace_revoked',
          'Workspace access was revoked. Pair this device again.',
        );
      if (identity(registry, candidate).role !== 'admin')
        throw new WorkspaceAdminError(
          403,
          'admin_required',
          'An administrator role is required to manage workspaces.',
        );
      return mutate(registry);
    });
  }
  function protectCurrent(candidate: RelayWorkspace, id: string) {
    protectOwner(id);
    if (candidate.id === id)
      throw new WorkspaceAdminError(
        409,
        'self_workspace',
        'Transfer administration before rotating or disabling this workspace, or use the server CLI for key rotation.',
      );
  }
  return {
    get owner() {
      return owner(readRegistry(directory));
    },
    list() {
      return entries()
        .filter((entry) => entry.enabled)
        .map(workspace);
    },
    authenticate(token: string): RelayWorkspace | undefined {
      if (!token || token.length > 4096) return undefined;
      // Read even for the owner: a broken registry must fail closed.
      const registry = readRegistry(directory);
      const current = registry.workspaces;
      const digest = hash(token);
      if (equal(digest, hash(ownerToken))) return owner(registry);
      const entry = current.find((item) => item.enabled && equal(digest, item.tokenHash));
      return entry ? workspace(entry) : undefined;
    },
    get(id: string): RelayWorkspace | undefined {
      const registry = readRegistry(directory);
      const current = registry.workspaces;
      if (id === 'owner') return owner(registry);
      const entry = current.find((item) => item.id === id && item.enabled);
      return entry ? workspace(entry) : undefined;
    },
    active(candidate: RelayWorkspace) {
      const current = this.get(candidate.id);
      return !!current && current.secret === candidate.secret;
    },
    administration(candidate: RelayWorkspace) {
      const registry = readRegistry(directory);
      const current = identity(registry, candidate);
      return {
        workspaceId: current.id,
        role: current.role,
        ...(current.role === 'admin' ? { workspaces: managementList(registry) } : {}),
      };
    },
    adminCreate(
      candidate: RelayWorkspace,
      sessionActive: () => boolean,
      input: unknown,
      now = Date.now,
    ) {
      const value = workspaceAdminInput.parse(input);
      return administrative(candidate, sessionActive, (registry) =>
        createEntry(registry, value.name, value.role, now),
      );
    },
    adminEdit(candidate: RelayWorkspace, sessionActive: () => boolean, id: string, input: unknown) {
      const value = workspaceAdminInput.parse(input);
      return administrative(candidate, sessionActive, (registry) => ({
        workspace: editEntry(registry, id, value.name, value.role),
      }));
    },
    adminRotate(candidate: RelayWorkspace, sessionActive: () => boolean, id: string) {
      return administrative(candidate, sessionActive, (registry) => {
        protectCurrent(candidate, id);
        return rotateEntry(registry, id);
      });
    },
    adminDisable(candidate: RelayWorkspace, sessionActive: () => boolean, id: string) {
      return administrative(candidate, sessionActive, (registry) => {
        protectCurrent(candidate, id);
        return { workspace: disableEntry(registry, id) };
      });
    },
  };
}
