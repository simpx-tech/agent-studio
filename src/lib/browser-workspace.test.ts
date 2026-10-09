import { expect, it } from 'vitest';
import { initialWorkspace } from './domain';
import { sharedWorkspace } from './sync';
import {
  BrowserWorkspaceStorageError,
  adoptBrowserStorage,
  browserScopeKey,
  clearBrowserWorkspace,
  discardOtherBrowserWorkspaces,
  readBrowserWorkspace,
  saveBrowserWorkspace,
  type BrowserWorkspaceStore,
} from './browser-workspace';

export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}
function memoryStore() {
  const data = new Map<string, string>();
  const store: BrowserWorkspaceStore = {
    get: async (keys) => keys.map((key) => data.get(key)),
    snapshot: async (keys, prefix) => ({
      values: keys.map((key) => data.get(key)),
      entries: [...data].filter(([key]) => key.startsWith(prefix)),
    }),
    put: async (entries, current = () => true) => {
      if (!current()) return false;
      for (const [key, value] of entries) data.set(key, value);
      return true;
    },
    update: async (change, current = () => true) => {
      if (!current()) return;
      const { put = [], remove = [] } = change([...data.keys()]);
      for (const key of remove) data.delete(key);
      for (const [key, value] of put) data.set(key, value);
    },
  };
  return { store, data };
}
const scope = { url: 'https://relay.example.com', workspaceId: 'owner', instanceId: 'original' };
const key = browserScopeKey(scope);
const checkpoint = (workspace = initialWorkspace()) =>
  JSON.stringify({ ...scope, base: sharedWorkspace(workspace) });

it('moves caches that earlier releases kept in localStorage into the store, keeping drafts there', async () => {
  const storage = memoryStorage();
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Saved computer' });
  storage.setItem(key, JSON.stringify(workspace));
  storage.setItem(`${key}:sync`, checkpoint(workspace));
  storage.setItem(`${key}:backup`, 'backup');
  storage.setItem(`${key}:drafts`, 'drafts');
  storage.setItem('agent-studio.installation', 'installation');
  await adoptBrowserStorage(store, storage);
  expect([...data.keys()].sort()).toEqual([key, `${key}:backup`, `${key}:sync`]);
  expect(data.get(`${key}:backup`)).toBe('backup');
  expect([storage.getItem(`${key}:drafts`), storage.getItem('agent-studio.installation')]).toEqual([
    'drafts',
    'installation',
  ]);
  expect(storage.length).toBe(2);
  expect((await readBrowserWorkspace(store, scope))?.workspace.fleet.computers[0].name).toBe(
    'Saved computer',
  );
});

it('never replaces stored data with an older localStorage copy or splits a snapshot from its checkpoint', async () => {
  const storage = memoryStorage();
  const { store, data } = memoryStore();
  data.set(`${key}:sync`, 'newer checkpoint');
  storage.setItem(key, 'older workspace');
  storage.setItem(`${key}:sync`, 'older checkpoint');
  storage.setItem(`${key}:backup`, 'older backup');
  await adoptBrowserStorage(store, storage);
  expect(Object.fromEntries(data)).toEqual({
    [`${key}:sync`]: 'newer checkpoint',
    [`${key}:backup`]: 'older backup',
  });
  expect(storage.length).toBe(0);
});

it('moves legacy browser data only into the owner scope of the same relay instance', async () => {
  const storage = memoryStorage();
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Owner computer' });
  storage.setItem('agent-studio.browser.v1', JSON.stringify(workspace));
  storage.setItem('agent-studio.browser-sync', checkpoint(workspace));
  storage.setItem('agent-studio.browser-backup', 'backup');
  await adoptBrowserStorage(store, storage);
  expect(storage.length).toBe(0);
  for (const other of [
    { ...scope, workspaceId: crypto.randomUUID() },
    { ...scope, instanceId: 'replaced' },
    { ...scope, url: 'https://another.example.com' },
  ])
    expect(await readBrowserWorkspace(store, other)).toBeUndefined();
  expect((await readBrowserWorkspace(store, scope))?.workspace.fleet.computers[0].name).toBe(
    'Owner computer',
  );
  // Damaged legacy data stays unmoved until an accepted identity discards it.
  data.clear();
  storage.setItem('agent-studio.browser.v1', '{damaged');
  storage.setItem('agent-studio.browser-sync', checkpoint(workspace));
  await adoptBrowserStorage(store, storage);
  expect(data.size).toBe(0);
  await discardOtherBrowserWorkspaces(store, storage, scope);
  expect(storage.length).toBe(0);
});

it('clears previous private caches, backups and drafts without clearing browser installation identity', async () => {
  const storage = memoryStorage();
  const { store, data } = memoryStore();
  const other = { ...scope, workspaceId: crypto.randomUUID() };
  for (const current of [scope, other]) {
    for (const suffix of ['', ':sync', ':backup'])
      data.set(`${browserScopeKey(current)}${suffix}`, '{}');
    storage.setItem(`${browserScopeKey(current)}:drafts`, '{}');
  }
  // A copy an earlier release saved in localStorage leaves with its workspace too.
  storage.setItem(browserScopeKey(scope), '{}');
  storage.setItem('agent-studio.installation', 'installation');
  await discardOtherBrowserWorkspaces(store, storage, other);
  expect([...data.keys()]).toEqual(
    ['', ':sync', ':backup'].map((suffix) => `${browserScopeKey(other)}${suffix}`),
  );
  expect(storage.getItem(browserScopeKey(scope))).toBeNull();
  expect(storage.getItem(`${browserScopeKey(scope)}:drafts`)).toBeNull();
  expect(storage.getItem(`${browserScopeKey(other)}:drafts`)).toBe('{}');
  await clearBrowserWorkspace(store, storage, other);
  expect(data.size).toBe(0);
  expect(storage.length).toBe(1);
  expect(storage.getItem('agent-studio.installation')).toBe('installation');
});

it('preserves damaged authenticated snapshots and checkpoints instead of overwriting local data', async () => {
  for (const broken of ['workspace', 'checkpoint', 'missing-checkpoint']) {
    const { store, data } = memoryStore();
    data.set(key, broken === 'workspace' ? '{damaged' : JSON.stringify(initialWorkspace()));
    if (broken !== 'missing-checkpoint')
      data.set(`${key}:sync`, broken === 'checkpoint' ? '{damaged' : checkpoint());
    const before = new Map(data);
    await expect(readBrowserWorkspace(store, scope)).rejects.toThrow(BrowserWorkspaceStorageError);
    expect(data).toEqual(before);
  }
});

const chat = (title: string) => ({
  id: crypto.randomUUID(),
  title,
  createdAt: '2026-09-26',
  updatedAt: '2026-09-26',
  settings: { provider: 'codex' as const, model: '', reasoning: '' as const, instructions: '' },
  messages: [],
});

it('writes one conversation per save and reads the workspace back whole', async () => {
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.conversations.push(chat('First'), chat('Second'));
  const [first, second] = workspace.conversations;
  data.set(`${key}:sync`, checkpoint());
  await saveBrowserWorkspace(store, key, workspace, undefined, () => true);
  expect([...data.keys()].sort()).toEqual(
    [`${key}:index`, `${key}:chat:${first.id}`, `${key}:chat:${second.id}`, `${key}:sync`].sort(),
  );
  // A streamed reply's checkpoint rewrites its own conversation, and nothing else.
  const untouched = data.get(`${key}:chat:${second.id}`);
  first.title = 'Renamed';
  await saveBrowserWorkspace(store, key, workspace, [first], () => true);
  expect(JSON.parse(data.get(`${key}:chat:${first.id}`)!).title).toBe('Renamed');
  expect(data.get(`${key}:chat:${second.id}`)).toBe(untouched);
  // The index never carries the conversations themselves.
  expect(data.get(`${key}:index`)).not.toContain('Renamed');
  const read = await readBrowserWorkspace(store, scope);
  expect(read?.workspace.conversations.map((c) => c.title)).toEqual(['Renamed', 'Second']);
  expect(read?.workspace).not.toHaveProperty('chats');
});

it('removes a deleted conversation and never writes past a changed session', async () => {
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.conversations.push(chat('First'), chat('Second'));
  const [first, second] = workspace.conversations;
  data.set(`${key}:sync`, checkpoint());
  await saveBrowserWorkspace(store, key, workspace, undefined, () => true);
  workspace.conversations = [first];
  await saveBrowserWorkspace(store, key, workspace, [], () => true);
  expect(data.has(`${key}:chat:${second.id}`)).toBe(false);
  expect((await readBrowserWorkspace(store, scope))?.workspace.conversations).toHaveLength(1);
  // A save queued by a session that has ended writes nothing.
  workspace.conversations = [];
  await saveBrowserWorkspace(store, key, workspace, undefined, () => false);
  expect(data.has(`${key}:chat:${first.id}`)).toBe(true);
});

it('reads a copy an earlier release wrote whole and replaces it on the next save', async () => {
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.conversations.push(chat('From the old cache'));
  data.set(key, JSON.stringify(workspace));
  data.set(`${key}:sync`, checkpoint());
  const read = await readBrowserWorkspace(store, scope);
  expect(read?.workspace.conversations.map((c) => c.title)).toEqual(['From the old cache']);
  await saveBrowserWorkspace(store, key, read!.workspace, undefined, () => true);
  expect(data.has(key)).toBe(false);
  expect((await readBrowserWorkspace(store, scope))?.workspace.conversations).toHaveLength(1);
});

it('opens a conversation whose entry another tab removed as the checkpoint holds it', async () => {
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  const synced = chat('Synced before');
  workspace.conversations.push(synced, chat('Never synced'));
  // The checkpoint holds the first conversation as the relay last had it.
  const base = initialWorkspace();
  base.conversations.push({ ...synced, title: 'Synced before, as the relay had it' });
  data.set(`${key}:sync`, checkpoint(base));
  await saveBrowserWorkspace(store, key, workspace, undefined, () => true);
  // A stale tab of this workspace saved without them, removing both entries.
  for (const conversation of workspace.conversations) data.delete(`${key}:chat:${conversation.id}`);
  const read = await readBrowserWorkspace(store, scope);
  expect(read?.workspace.conversations.map((c) => c.title)).toEqual([
    'Synced before, as the relay had it',
  ]);
});

const recorded = (title: string, status: 'complete' | 'running' = 'complete') => ({
  ...chat(title),
  messages: [
    {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      status,
      createdAt: '2026-09-26',
      blocks: [
        { type: 'activity' as const, text: 'Ran the tests' },
        { type: 'markdown' as const, text: `${title} done.` },
      ],
      fileChanges: { revision: 1, edits: [], limited: false },
    },
  ],
});

it('keeps a reply saved as running, which a browser never runs, running', async () => {
  const { store, data } = memoryStore();
  const workspace = initialWorkspace();
  workspace.conversations.push(recorded('Running elsewhere', 'running'));
  data.set(`${key}:sync`, checkpoint(workspace));
  await saveBrowserWorkspace(store, key, workspace, undefined, () => true);
  const [message] = (await readBrowserWorkspace(store, scope))!.workspace.conversations[0].messages;
  expect(message.status).toBe('running');
  expect(message.error).toBeUndefined();
});

it('reads a copy saved whole light, keeping whole only the work the relay lacks', async () => {
  const { store, data } = memoryStore();
  const synced = recorded('Synced');
  const fork = recorded('Forked here');
  const base = initialWorkspace();
  base.conversations.push(synced);
  data.set(`${key}:sync`, checkpoint(base));
  const workspace = initialWorkspace();
  workspace.conversations.push(synced, fork);
  await saveBrowserWorkspace(store, key, workspace, undefined, () => true);
  const read = (await readBrowserWorkspace(store, scope, true))!;
  expect(read.lightened).toBe(true);
  // The baseline and what the relay holds lose their recorded work, kept by the relay.
  expect(read.base.conversations[0].messages[0].blocks).toEqual([
    { type: 'markdown', text: 'Synced done.' },
  ]);
  const [light, whole] = read.workspace.conversations;
  expect(light.messages[0]).not.toHaveProperty('fileChanges');
  expect(light.messages[0].blocks).toHaveLength(1);
  // A message only this device holds stays whole until it reaches the relay.
  expect(whole.messages[0]).toEqual(fork.messages[0]);
  // A copy already light reads back unchanged.
  await saveBrowserWorkspace(store, key, read.workspace, undefined, () => true);
  data.set(`${key}:sync`, JSON.stringify({ ...scope, base: read.base }));
  expect((await readBrowserWorkspace(store, scope, true))!.lightened).toBe(false);
});
