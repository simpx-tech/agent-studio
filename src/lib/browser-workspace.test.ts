import { expect, it } from 'vitest';
import { initialWorkspace } from './domain';
import { sharedWorkspace } from './sync';
import {
  BrowserWorkspaceStorageError,
  browserScopeKey,
  clearBrowserWorkspace,
  discardOtherBrowserWorkspaces,
  readBrowserWorkspace,
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
const scope = { url: 'https://relay.example.com', workspaceId: 'owner', instanceId: 'original' };

it('migrates legacy browser data only for the authenticated owner on the same relay instance', () => {
  const storage = memoryStorage();
  const workspace = initialWorkspace();
  workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Owner computer' });
  storage.setItem('agent-studio.browser.v1', JSON.stringify(workspace));
  storage.setItem(
    'agent-studio.browser-sync',
    JSON.stringify({ ...scope, base: sharedWorkspace(workspace) }),
  );
  expect(
    readBrowserWorkspace(storage, { ...scope, workspaceId: crypto.randomUUID() }),
  ).toBeUndefined();
  expect(readBrowserWorkspace(storage, { ...scope, instanceId: 'replaced' })).toBeUndefined();
  expect(
    readBrowserWorkspace(storage, { ...scope, url: 'https://another.example.com' }),
  ).toBeUndefined();
  expect(readBrowserWorkspace(storage, scope)?.workspace.fleet.computers[0].name).toBe(
    'Owner computer',
  );
  expect(storage.getItem('agent-studio.browser.v1')).toBeNull();
  expect(storage.getItem('agent-studio.browser-sync')).toBeNull();
});

it('clears previous private caches and backups without clearing browser installation identity', () => {
  const storage = memoryStorage();
  const other = { ...scope, workspaceId: crypto.randomUUID() };
  for (const current of [scope, other]) {
    for (const suffix of ['', ':sync', ':backup'])
      storage.setItem(`${browserScopeKey(current)}${suffix}`, '{}');
  }
  storage.setItem('agent-studio.installation', 'installation');
  discardOtherBrowserWorkspaces(storage, other);
  expect(storage.getItem(browserScopeKey(scope))).toBeNull();
  expect(storage.getItem(`${browserScopeKey(scope)}:backup`)).toBeNull();
  expect(storage.getItem(browserScopeKey(other))).toBe('{}');
  clearBrowserWorkspace(storage, other);
  expect(storage.length).toBe(1);
  expect(storage.getItem('agent-studio.installation')).toBe('installation');
});

it('preserves damaged authenticated snapshots and checkpoints instead of overwriting local data', () => {
  for (const broken of ['workspace', 'checkpoint', 'missing-checkpoint']) {
    const storage = memoryStorage();
    const key = browserScopeKey(scope);
    const workspace = initialWorkspace();
    storage.setItem(key, broken === 'workspace' ? '{damaged' : JSON.stringify(workspace));
    if (broken !== 'missing-checkpoint')
      storage.setItem(
        `${key}:sync`,
        broken === 'checkpoint'
          ? '{damaged'
          : JSON.stringify({ ...scope, base: sharedWorkspace(workspace) }),
      );
    const before = [storage.getItem(key), storage.getItem(`${key}:sync`)];
    expect(() => readBrowserWorkspace(storage, scope)).toThrow(BrowserWorkspaceStorageError);
    expect([storage.getItem(key), storage.getItem(`${key}:sync`)]).toEqual(before);
  }
});
