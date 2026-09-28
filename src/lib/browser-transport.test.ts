import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChangeMarks, type ChangeSet } from './change-marks';
import { initialWorkspace, type Conversation, type Workspace } from './domain';
import { sharedChatSchema, sharedMeta, sharedWorkspace, type SharedMeta } from './sync';
import { browserScopeKey, browserSessionSignal, saveBrowserWorkspace } from './browser-workspace';
import { browserWorkspaceStore } from './browser-store';
import { createHash } from 'node:crypto';

// What changed on this device since the last sync, tracked as the page tracks it. Like a
// window that has just synced, it starts with nothing waiting.
function chatMarks() {
  const changes = createChangeMarks();
  changes.takeUnsaved();
  changes.takeUnsynced();
  return { changes, mark: (chatId?: string) => changes.chat(chatId) };
}
// The per-conversation runtime members, which every device provides the same way.
function chatRuntime(get: () => Workspace, marks = chatMarks()) {
  return {
    chat: (id: string) => {
      const conversation = get().conversations.find((c) => c.id === id);
      return conversation && sharedChatSchema.parse(conversation);
    },
    chatIds: () => get().conversations.map((c) => c.id),
    meta: () => sharedMeta(get()),
    takeUnsynced: () => marks.changes.takeUnsynced(),
    restoreUnsynced: (changes: ChangeSet) => marks.changes.restoreUnsynced(changes),
    applyChats: async (upsert: Conversation[], remove: string[], meta?: SharedMeta) => {
      const workspace = get();
      if (meta) Object.assign(workspace, meta);
      const gone = new Set(remove);
      workspace.conversations = workspace.conversations.filter((c) => !gone.has(c.id));
      for (const incoming of upsert) {
        const at = workspace.conversations.findIndex((c) => c.id === incoming.id);
        if (at >= 0) workspace.conversations[at] = incoming;
        else workspace.conversations.push(incoming);
      }
    },
  };
}

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
    snapshot: async (keys: string[], prefix: string) => ({
      values: keys.map((key) => cache.get(key)),
      entries: [...cache].filter(([key]) => key.startsWith(prefix)),
    }),
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
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
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
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
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
  // The Viewer keeps an index beside one entry per conversation; this workspace has none.
  expect([...cache.keys()]).toEqual([`${oldScope}:sync`, `${oldScope}:index`]);
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

it('turns images a Viewer copy saved inline into the references the relay keeps', async () => {
  const { transport, session, replace, fetcher } = await fixture();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  );
  // One image the relay moved into its store, one only this browser has, and one it refuses.
  const [kept, local, refused] = [0, 1, 2].map((n) => Buffer.concat([png, Buffer.from([n])]));
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const relayImages = new Map([[sha(kept), kept]]);
  const inline = (bytes: Buffer) => ({
    id: crypto.randomUUID(),
    name: 'shot.png',
    mediaType: 'image/png' as const,
    data: bytes.toString('base64'),
  });
  const images = [inline(kept), inline(local), inline(refused)];
  const saved = initialWorkspace();
  const chat: Conversation = {
    id: crypto.randomUUID(),
    title: 'Legacy',
    createdAt: '2026-09-27',
    updatedAt: '2026-09-27',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [],
        images,
        status: 'complete',
        createdAt: '2026-09-27',
      },
    ],
  };
  saved.conversations.push(chat);
  // The copy and checkpoint an earlier release of the Viewer saved.
  const scope = {
    url: 'https://relay.example.com',
    workspaceId: 'alice',
    instanceId: 'instance-alice',
  };
  const key = browserScopeKey(scope);
  await saveBrowserWorkspace(browserWorkspaceStore, key, saved, undefined, () => true);
  const revisions = { revision: 3, chats: { [chat.id]: 3 }, metaRevision: 3 };
  cache.set(
    `${key}:sync`,
    JSON.stringify({
      url: scope.url,
      instanceId: scope.instanceId,
      base: sharedWorkspace(saved),
      revisions,
    }),
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, options: RequestInit) => {
    if (path === '/v1/state/revision')
      return json({ instanceId: 'instance-alice', workspaceId: 'alice', revision: 3, images: 1 });
    if (path === '/v1/images/missing') {
      const { hashes } = JSON.parse(String(options.body)) as { hashes: string[] };
      return json({ missing: hashes.filter((hash) => !relayImages.has(hash)) });
    }
    const hash = /^\/v1\/images\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (hash && options.method === 'PUT') {
      if (hash === sha(refused)) return json({ error: 'Refused.' }, 400);
      relayImages.set(hash, Buffer.from(await (options.body as Blob).arrayBuffer()));
      return json({ hash });
    }
    return original(path, options);
  });
  session('alice');
  expect(await transport.resumeBrowserRelay()).toBe(true);
  // The relay now holds the image only this browser had, as its bytes.
  expect(relayImages.get(sha(local))).toEqual(local);
  expect(relayImages.has(sha(refused))).toBe(false);
  const reference = (image: (typeof images)[number], bytes: Buffer) => ({
    id: image.id,
    name: 'shot.png',
    mediaType: 'image/png',
    hash: sha(bytes),
    bytes: bytes.length,
  });
  // Both the copy and the checkpoint name the images as the relay does; the refused one stays
  // inline, and the checkpoint keeps its revisions.
  const expected = [reference(images[0], kept), reference(images[1], local), images[2]];
  expect(replace.mock.calls.at(-1)![0].conversations[0].messages[0].images).toEqual(expected);
  const checkpoint = JSON.parse(cache.get(`${key}:sync`)!);
  expect(checkpoint.base.conversations[0].messages[0].images).toEqual(expected);
  expect(checkpoint.revisions).toEqual(revisions);
});
