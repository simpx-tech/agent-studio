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
    put: async (entries, current = () => true) => {
      if (!current()) return false;
      for (const [key, value] of entries) data.set(key, value);
      return true;
    },
    update: async (change) => {
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
