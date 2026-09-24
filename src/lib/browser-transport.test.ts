import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialWorkspace, type Workspace } from './domain';
import { sharedWorkspace } from './sync';
import { browserSessionSignal } from './browser-workspace';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: () => false,
  Channel: class {},
}));
// Stands in for the Viewer's IndexedDB workspace store.
const cache = vi.hoisted(() => new Map<string, string>());
vi.mock('./browser-store', () => ({
  browserWorkspaceStore: {
    get: async (keys: string[]) => keys.map((key) => cache.get(key)),
    put: async (entries: [string, string][], current = () => true) => {
      await Promise.resolve();
      if (!current()) return false;
      for (const [key, value] of entries) cache.set(key, value);
      return true;
    },
    update: async (change: (keys: string[]) => { put?: [string, string][]; remove?: string[] }) => {
      const { put = [], remove = [] } = change([...cache.keys()]);
      for (const key of remove) cache.delete(key);
      for (const [key, value] of put) cache.set(key, value);
    },
  },
}));

function memoryStorage(): Storage {
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

beforeEach(() => {
  vi.resetModules();
  cache.clear();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('navigator', {});
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { location: { origin: 'https://relay.example.com' } }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const transport = await import('./transport');
  let workspace = initialWorkspace();
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'Browser',
    platform: 'preview' as const,
  };
  const data: Record<string, Workspace> = {};
  for (const id of ['alice', 'bob']) {
    data[id] = initialWorkspace();
    data[id].fleet.computers.push({ id: crypto.randomUUID(), name: `${id} private computer` });
  }
  let session: string | undefined;
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    const headers = options.headers as Record<string, string>;
    if (path === '/v1/browser-session' && options.method === 'POST') {
      session = JSON.parse(String(options.body)).token;
      return response({ workspaceId: session, environmentId: installation.id });
    }
    if (!session) return response({ error: 'Unauthorized' }, 401);
    if (headers['X-Workspace-Id'] && headers['X-Workspace-Id'] !== session)
      return response({ code: 'workspace_changed', error: 'Changed' }, 409);
    if (path === '/v1/browser-session') {
      if (options.method === 'DELETE') session = undefined;
      return response({ workspaceId: session, environmentId: installation.id });
    }
    if (path === '/v1/state') {
      if (options.method === 'PUT')
        data[session] = { ...data[session], ...JSON.parse(String(options.body)).workspace };
      return response({
        workspaceId: session,
        instanceId: `instance-${session}`,
        revision: 0,
        workspace: sharedWorkspace(data[session]),
      });
    }
    return response([]);
  });
  vi.stubGlobal('fetch', fetcher);
  const replace = vi.fn(async (value: Workspace) => {
    workspace = value;
  });
  transport.configureRuntime({
    installation,
    workspace: () => workspace,
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (shared) => {
      workspace = { ...workspace, ...shared };
    },
    replaceBrowserWorkspace: replace,
    checkpointRun: async () => {},
  });
  return {
    transport,
    workspace: () => workspace,
    data,
    fetcher,
    replace,
    session: (value?: string) => {
      session = value;
    },
  };
}

it('does not expose or overwrite unscoped cached chats before authentication', async () => {
  const { transport, fetcher } = await fixture();
  const previous = initialWorkspace();
  previous.fleet.computers.push({ id: crypto.randomUUID(), name: 'Previous private computer' });
  localStorage.setItem('agent-studio.browser.v1', JSON.stringify(previous));
  expect((await transport.loadWorkspace()).fleet.computers).toEqual([]);
  await transport.saveWorkspace(previous);
  expect(await transport.resumeBrowserRelay()).toBe(false);
  expect(fetcher.mock.calls.some(([path]) => path === '/v1/state')).toBe(false);
});

it('pins browser requests to the authenticated workspace and switches without merging or retaining the old cache', async () => {
  const { transport, workspace, data, fetcher } = await fixture();
  await transport.connectRelay(window.location.origin, 'alice');
  await transport.pollRelay();
  await transport.saveWorkspace(workspace());
  const oldScope = transport.workspaceStorageScope()!;
  expect([...cache.keys()]).toEqual([`${oldScope}:sync`, oldScope]);
  const oldWorkspace = structuredClone(workspace());
  await transport.connectRelay(window.location.origin, 'bob');
  await transport.saveWorkspace(oldWorkspace, oldScope);
  await transport.pollRelay();
  expect(workspace().fleet.computers.map((computer) => computer.name)).toEqual([
    'bob private computer',
  ]);
  expect(data.bob.fleet.computers.map((computer) => computer.name)).toEqual([
    'bob private computer',
  ]);
  expect([...cache.keys()].filter((key) => key.startsWith(oldScope))).toEqual([]);
  for (const [path, options] of fetcher.mock.calls) {
    if (path !== '/v1/browser-session')
      expect((options.headers as Record<string, string>)['X-Workspace-Id']).toMatch(/alice|bob/);
  }
  await transport.disconnectRelay();
  expect(workspace().fleet.computers).toEqual([]);
  expect(transport.workspaceStorageScope()).toBeNull();
});

it('clears an expired or mismatched session and never adopts the new cookie automatically', async () => {
  const { transport, workspace, session, fetcher } = await fixture();
  await transport.connectRelay(window.location.origin, 'alice');
  session('bob');
  await expect(transport.pollRelay()).rejects.toThrow('Changed');
  expect(workspace().fleet.computers).toEqual([]);
  const requestCount = fetcher.mock.calls.length;
  expect(await transport.resumeBrowserRelay()).toBe(false);
  expect(await transport.pollRelay()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(requestCount);
});

it('clears visible state in a stale tab as soon as another tab switches workspaces', async () => {
  const { transport, workspace } = await fixture();
  await transport.connectRelay(window.location.origin, 'alice');
  const stop = transport.watchBrowserSession();
  const event = Object.assign(new Event('storage'), {
    key: browserSessionSignal,
    newValue: JSON.stringify({ workspaceId: 'bob' }),
  });
  window.dispatchEvent(event);
  expect(workspace().fleet.computers).toEqual([]);
  expect(await transport.resumeBrowserRelay()).toBe(false);
  expect(await transport.pollRelay()).toBeNull();
  stop();
});

it('preserves an initial notification target only while restoring an authenticated session', async () => {
  const { transport, session, replace } = await fixture();
  session('alice');
  expect(await transport.resumeBrowserRelay()).toBe(true);
  expect(replace).toHaveBeenLastCalledWith(expect.anything(), undefined, true);
  await transport.connectRelay(window.location.origin, 'bob');
  expect(replace).toHaveBeenLastCalledWith(expect.anything(), undefined, false);
});
