import {
  initialWorkspace,
  restoreWorkspace,
  type Conversation,
  type Message,
  type Workspace,
} from './domain';
import { sharedSchema, type SharedWorkspace } from './sync';
import { lightChat, messageIds } from './light-chats';

export type BrowserWorkspaceScope = {
  url: string;
  workspaceId: string;
  instanceId: string;
};
// The Viewer keeps its private workspace copy, sync checkpoint and backup in IndexedDB.
// localStorage holds only about 5 MB per origin, less than two copies of a large workspace.
export type BrowserWorkspaceStore = {
  get(keys: string[]): Promise<unknown[]>;
  // Reads the given keys and every entry whose key starts with `prefix` in one transaction, so
  // no other tab's write lands between them.
  snapshot(
    keys: string[],
    prefix: string,
  ): Promise<{ values: unknown[]; entries: [string, unknown][] }>;
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
// A browser runs no replies: one saved as running still runs on its computer.
const viewer = { followsRuns: true };
const indexKey = (key: string) => `${key}:index`;
const chatKey = (key: string, id: string) => `${key}:chat:${id}`;
export const browserChatOrder = (index: unknown): string[] => {
  const chats = (index as { chats?: unknown })?.chats;
  if (!Array.isArray(chats) || chats.some((id) => typeof id !== 'string'))
    throw new BrowserWorkspaceStorageError();
  return chats as string[];
};

/**
 * Writes the index and the conversations given, or all of them when none are named, each as
 * `stored` gives it: a light connection leaves out the work the relay keeps.
 */
export async function saveBrowserWorkspace(
  store: BrowserWorkspaceStore,
  key: string,
  workspace: Workspace,
  changed: Conversation[] | undefined,
  current: () => boolean,
  stored: (conversation: Conversation) => Conversation = (conversation) => conversation,
) {
  const { conversations, ...rest } = workspace;
  const order = conversations.map((c) => c.id);
  const entries: [string, string][] = [
    [indexKey(key), JSON.stringify({ ...rest, chats: order })],
  ];
  for (const conversation of changed ?? conversations)
    entries.push([chatKey(key, conversation.id), JSON.stringify(stored(conversation))]);
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
  // Whether this connection holds chats light (src/lib/light-chats.ts). A copy an earlier release
  // saved whole is read light, one conversation at a time.
  light = false,
) {
  const key = browserScopeKey(scope);
  // The index and its conversations are read together: another tab writing between two reads
  // could remove an entry the first read listed.
  const { values, entries } = await store.snapshot(
    [key, indexKey(key), `${key}:sync`],
    chatKey(key, ''),
  );
  // Each saved string is let go once it is read: a copy saved whole holds tens of megabytes.
  const take = (at: number) => {
    const value = values[at];
    values[at] = undefined;
    return value;
  };
  const whole = take(0);
  const index = take(1);
  let checkpoint = take(2);
  const saved = index === undefined ? whole : index;
  if (saved === undefined && checkpoint === undefined) return undefined;
  try {
    if (typeof checkpoint !== 'string') throw new BrowserWorkspaceStorageError();
    const previous = JSON.parse(checkpoint);
    checkpoint = undefined;
    if (previous.url !== scope.url || previous.instanceId !== scope.instanceId)
      throw new BrowserWorkspaceStorageError();
    // Whether this read found whole what a light connection holds light, which an earlier release
    // saved, so the caller writes the checkpoint back light instead of reading it whole again.
    let lightened = false;
    const lighter = (conversation: Conversation, keep?: (message: Message) => boolean) => {
      const light = lightChat(conversation, keep);
      if (light !== conversation) lightened = true;
      return light;
    };
    // The baseline is the relay's own data, whose work the relay keeps.
    if (light && Array.isArray(previous.base?.conversations))
      previous.base.conversations = previous.base.conversations.map((c: Conversation) =>
        lighter(c),
      );
    const base = sharedSchema.parse(previous.base);
    // A message the baseline lacks is one only this device holds, which stays whole.
    const held = light ? messageIds(base.conversations) : undefined;
    const kept = (conversation: Conversation) =>
      held ? lighter(conversation, (message) => !held.has(message.id)) : conversation;
    // The revisions this baseline came from, when the checkpoint was written with them.
    const revisions: unknown = previous.revisions;
    if (saved === undefined) return undefined;
    if (typeof saved !== 'string') throw new BrowserWorkspaceStorageError();
    const parsed = JSON.parse(saved);
    if (index === undefined) {
      if (held && Array.isArray(parsed.conversations))
        parsed.conversations = parsed.conversations.map(kept);
      return { workspace: restoreWorkspace(parsed, viewer), base, revisions, lightened };
    }
    const order = browserChatOrder(parsed);
    const stored = new Map(entries.map(([entry, value]) => [entry, value]));
    entries.length = 0;
    const checkpointed = new Map(base.conversations.map((c) => [c.id, c]));
    const conversations = order.flatMap((id) => {
      const value = stored.get(chatKey(key, id));
      stored.delete(chatKey(key, id));
      if (typeof value === 'string') return [kept(JSON.parse(value))];
      // Another tab of this workspace removes the entry of a conversation it never received,
      // after this index listed it. The conversation opens as the checkpoint holds it, and the
      // relay's copy merges over it, rather than locking this browser out of its workspace. One
      // the checkpoint lacks returns from the relay on the next sync if it ever reached it.
      const synced = checkpointed.get(id);
      return synced ? [synced] : [];
    });
    return {
      workspace: restoreWorkspace({ ...parsed, chats: undefined, conversations }, viewer),
      base,
      revisions,
      lightened,
    };
  } catch {
    throw new BrowserWorkspaceStorageError();
  }
}

export function browserWorkspaceFromServer(shared: SharedWorkspace): Workspace {
  return { ...initialWorkspace(), ...shared };
}
