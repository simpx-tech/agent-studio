import {
  initialWorkspace,
  restoreWorkspace,
  type Conversation,
  type Workspace,
} from './domain';
import { sharedSchema, type SharedWorkspace } from './sync';

export type BrowserWorkspaceScope = {
  url: string;
  workspaceId: string;
  instanceId: string;
};
// The Viewer keeps its private workspace copy, sync checkpoint and backup in IndexedDB.
// localStorage holds only about 5 MB per origin, less than two copies of a large workspace.
export type BrowserWorkspaceStore = {
  get(keys: string[]): Promise<unknown[]>;
  // Writes only while `current` holds when the write starts, so a save from a former
  // session cannot land after that session's data was cleared.
  put(entries: [string, string][], current?: () => boolean): Promise<boolean>;
  // Chooses what to write or remove from the stored keys, within one transaction. Writes only
  // while `current` holds, as `put` does.
  update(
    change: (keys: string[]) => { put?: [string, string][]; remove?: string[] },
    current?: () => boolean,
  ): Promise<void>;
};
export class BrowserWorkspaceStorageError extends Error {
  constructor() {
    super(
      'This browser’s saved private workspace could not be read. No saved data has been overwritten. Pair another browser to access the server copy, and recover this browser’s local data before clearing its storage.',
    );
    this.name = 'BrowserWorkspaceStorageError';
  }
}
export const browserSessionSignal = 'agent-studio.browser-session-change';
const scopePrefix = 'agent-studio.private-workspace.v1:';
const legacyKeys = [
  'agent-studio.browser.v1',
  'agent-studio.browser-sync',
  'agent-studio.browser-backup',
];
export const browserScopeKey = (scope: BrowserWorkspaceScope) =>
  `${scopePrefix}${encodeURIComponent(JSON.stringify([scope.url, scope.workspaceId, scope.instanceId]))}`;

// The unscoped copy saved before private workspaces belongs to the owner of its relay instance.
function legacyOwnerCopy(storage: Storage): [string, string][] | undefined {
  const saved = storage.getItem('agent-studio.browser.v1');
  const checkpoint = storage.getItem('agent-studio.browser-sync');
  if (!saved || !checkpoint) return undefined;
  try {
    const previous = JSON.parse(checkpoint);
    if (typeof previous.url !== 'string' || typeof previous.instanceId !== 'string')
      return undefined;
    // Validate before removing the old, unscoped copy.
    restoreWorkspace(JSON.parse(saved));
    sharedSchema.parse(previous.base);
    const key = browserScopeKey({
      url: previous.url,
      workspaceId: 'owner',
      instanceId: previous.instanceId,
    });
    return [
      [key, saved],
      [`${key}:sync`, checkpoint],
    ];
  } catch {
    // Untrusted or damaged legacy data must not replace the server workspace.
    return undefined;
  }
}

// Earlier releases kept this cache in localStorage. Move it into the store unchanged, never
// replacing newer stored data; drafts stay in localStorage.
export async function adoptBrowserStorage(store: BrowserWorkspaceStore, storage: Storage) {
  const copies = new Map<string, string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(scopePrefix) && !key.endsWith(':drafts'))
      copies.set(key, storage.getItem(key) ?? '');
  }
  const legacy = legacyOwnerCopy(storage);
  if (legacy && !legacy.some(([key]) => copies.has(key)))
    for (const [key, value] of legacy) copies.set(key, value);
  if (copies.size) {
    await store.update((keys) => {
      const stored = new Set(keys);
      return {
        put: [...copies].filter(([key]) => {
          if (key.endsWith(':backup')) return !stored.has(key);
          // A saved workspace moves only together with its own checkpoint.
          const scope = key.replace(/:sync$/, '');
          return (
            !stored.has(scope) && !stored.has(`${scope}:index`) && !stored.has(`${scope}:sync`)
          );
        }),
      };
    });
  }
  for (const key of copies.keys()) storage.removeItem(key);
  if (legacy) for (const key of legacyKeys) storage.removeItem(key);
}

export async function clearBrowserWorkspace(
  store: BrowserWorkspaceStore,
  storage: Storage,
  scope: BrowserWorkspaceScope,
) {
  const key = browserScopeKey(scope);
  // Drafts, and copies an earlier release has not moved yet, are in localStorage.
  for (const suffix of ['', ':sync', ':backup', ':drafts']) storage.removeItem(`${key}${suffix}`);
  await store.update((keys) => ({
    remove: keys.filter((stored) => stored === key || stored.startsWith(`${key}:`)),
  }));
}

export async function discardOtherBrowserWorkspaces(
  store: BrowserWorkspaceStore,
  storage: Storage,
  scope: BrowserWorkspaceScope,
) {
  const keep = browserScopeKey(scope);
  const other = (key: string) =>
    key.startsWith(scopePrefix) && key !== keep && !key.startsWith(`${keep}:`);
  const remove: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && other(key)) remove.push(key);
  }
  for (const key of remove) storage.removeItem(key);
  // Legacy data can only move into the store above after validation. Once an identity is
  // accepted, do not leave unscoped chat copies behind.
  for (const key of [...legacyKeys, 'agent-studio.preview.v1']) storage.removeItem(key);
  await store.update((keys) => ({ remove: keys.filter(other) }));
}

/**
 * The Viewer keeps one entry per conversation beside an index of everything else, so applying a
 * streamed reply's checkpoint writes that conversation alone. Releases before this kept the whole
 * workspace under the scope key itself; it is read once more and replaced on the next save.
 */
const indexKey = (key: string) => `${key}:index`;
const chatKey = (key: string, id: string) => `${key}:chat:${id}`;
export const browserChatOrder = (index: unknown): string[] => {
  const chats = (index as { chats?: unknown })?.chats;
  if (!Array.isArray(chats) || chats.some((id) => typeof id !== 'string'))
    throw new BrowserWorkspaceStorageError();
  return chats as string[];
};

/** Writes the index and the conversations given, or all of them when none are named. */
export async function saveBrowserWorkspace(
  store: BrowserWorkspaceStore,
  key: string,
  workspace: Workspace,
  changed: Conversation[] | undefined,
  current: () => boolean,
) {
  const { conversations, ...rest } = workspace;
  const order = conversations.map((c) => c.id);
  const entries: [string, string][] = [
    [indexKey(key), JSON.stringify({ ...rest, chats: order })],
  ];
  for (const conversation of changed ?? conversations)
    entries.push([chatKey(key, conversation.id), JSON.stringify(conversation)]);
  const kept = new Set(order.map((id) => chatKey(key, id)));
  await store.update(
    (keys) => ({
      put: entries,
      // The copy an earlier release wrote whole, and any conversation that is gone.
      remove: keys.filter(
        (stored) =>
          stored === key || (stored.startsWith(`${key}:chat:`) && !kept.has(stored)),
      ),
    }),
    current,
  );
}

// A saved browser snapshot is never an authentication source. Call only after the
// server has confirmed both the session's workspace and that workspace's instance.
export async function readBrowserWorkspace(
  store: BrowserWorkspaceStore,
  scope: BrowserWorkspaceScope,
) {
  const key = browserScopeKey(scope);
  const [whole, index, checkpoint] = await store.get([key, indexKey(key), `${key}:sync`]);
  const saved = index === undefined ? whole : index;
  if (saved === undefined && checkpoint === undefined) return undefined;
  try {
    if (typeof checkpoint !== 'string') throw new BrowserWorkspaceStorageError();
    const previous = JSON.parse(checkpoint);
    if (previous.url !== scope.url || previous.instanceId !== scope.instanceId)
      throw new BrowserWorkspaceStorageError();
    const base = sharedSchema.parse(previous.base);
    // The revisions this baseline came from, when the checkpoint was written with them.
    const revisions: unknown = previous.revisions;
    if (saved === undefined) return undefined;
    if (typeof saved !== 'string') throw new BrowserWorkspaceStorageError();
    const parsed = JSON.parse(saved);
    if (index === undefined) return { workspace: restoreWorkspace(parsed), base, revisions };
    const order = browserChatOrder(parsed);
    const stored = await store.get(order.map((id) => chatKey(key, id)));
    // A conversation the index lists must be there; never open a workspace missing one.
    if (stored.some((value) => typeof value !== 'string'))
      throw new BrowserWorkspaceStorageError();
    const conversations = (stored as string[]).map((value) => JSON.parse(value));
    return {
      workspace: restoreWorkspace({ ...parsed, chats: undefined, conversations }),
      base,
      revisions,
    };
  } catch {
    throw new BrowserWorkspaceStorageError();
  }
}

export function browserWorkspaceFromServer(shared: SharedWorkspace): Workspace {
  return { ...initialWorkspace(), ...shared };
}
