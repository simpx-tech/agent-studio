import { beforeEach, expect, it, vi } from 'vitest';
import {
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Workspace,
} from './domain';
import {
  emptyShared,
  sharedChatSchema,
  sharedMeta,
  sharedWorkspace,
  type SharedMeta,
  type SharedWorkspace,
} from './sync';

// Conversations changed on this device since the last sync, as the page tracks them.
function chatMarks() {
  const marks = {
    unsynced: new Set<string>() as Set<string> | undefined,
    mark(chatId?: string) {
      if (chatId === undefined) marks.unsynced = undefined;
      else if (marks.unsynced) marks.unsynced.add(chatId);
    },
  };
  return marks;
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
    takeUnsynced: () => {
      const pending = marks.unsynced;
      marks.unsynced = new Set();
      return pending;
    },
    restoreUnsynced: (ids: Set<string> | undefined) => {
      if (ids === undefined || !marks.unsynced) marks.unsynced = undefined;
      else for (const id of ids) marks.unsynced.add(id);
    },
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

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  isTauri: () => true,
  Channel: class {},
}));

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  vi.unstubAllGlobals();
});

it('invalidates host skill inventories after Viewer plugin mutations, including uncertain failures', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const host = crypto.randomUUID(),
    computerId = crypto.randomUUID();
  const connectionId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computerId, name: 'QA' });
  workspace.fleet.environments.push({ id: host, computerId, name: 'QA', platform: 'windows' });
  workspace.fleet.accounts.push({
    id: accountId,
    provider: 'codex',
    name: 'QA',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: host,
    profile: 'existing',
  });
  transport.configureRuntime({
    installation: { id: host, computerId, name: 'QA', platform: 'windows' },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  const changed = vi.fn();
  const events = new EventTarget();
  events.addEventListener('studio-skills-changed', changed);
  vi.stubGlobal('window', events);
  const clear = vi.spyOn(transport.contextCache, 'clear');
  const job = {
    id: crypto.randomUUID(),
    method: 'plugins',
    args: {
      provider: 'codex',
      connectionId,
      action: { kind: 'skill', path: '/fixture/SKILL.md', enabled: false },
    },
  };
  let claimed = false;
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'manage_plugins') throw new Error('Unconfirmed CLI result');
    if (command === 'relay_request' && args.path === 'v1/state')
      return {
        status: 200,
        body: { instanceId: 'same-relay', workspace: sharedWorkspace(workspace), revision: 0 },
      };
    if (command === 'relay_request' && args.path === 'v1/jobs') {
      const jobs = claimed ? [] : [job];
      claimed = true;
      return { status: 200, body: jobs };
    }
    if (command === 'relay_request' && args.path === `v1/jobs/${job.id}`)
      return { status: 200, body: { status: 'error' } };
    return original(command, args);
  });
  await transport.resumeRelay();
  clear.mockClear();
  await transport.pollRelay();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(clear).toHaveBeenCalledOnce();
  expect(native.invoke).toHaveBeenCalledWith('manage_plugins', job.args);
  await vi.waitFor(() =>
    expect(
      native.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'relay_request' &&
          args.path === `v1/jobs/${job.id}` &&
          args.body.status === 'error',
      ),
    ).toBe(true),
  );
  await transport.disconnectRelay();
});

it('routes MCP management and OAuth polling to the exact selected host', async () => {
  const connectionId = crypto.randomUUID();
  const transport = await fixture(connectionId);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return {
        status: 200,
        body: {
          status: 'complete',
          events: [],
          result: { status: 'pending', servers: [], message: 'Waiting', operationId: 'synthetic' },
        },
      };
    return original(command, args);
  });
  const action = { kind: 'authenticate' as const, name: 'docs' };
  await transport.manageMcp({ provider: 'codex', connectionId }, undefined, undefined, action);
  const call = native.invoke.mock.calls.find(
    ([command, args]) =>
      command === 'relay_request' && args.method === 'POST' && args.path === 'v1/jobs',
  );
  expect(call?.[1].body).toMatchObject({
    method: 'mcp',
    args: { provider: 'codex', connectionId, action },
  });
  expect(native.invoke.mock.calls.some(([command]) => command === 'manage_mcp')).toBe(false);
  await transport.disconnectRelay();
  await expect(
    transport.manageMcp({ provider: 'codex', connectionId }, undefined, undefined, action),
  ).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'manage_mcp')).toBe(false);
});

it('routes bounded mention discovery to its selected host and rejects offline fallback', async () => {
  const connectionId = crypto.randomUUID();
  const transport = await fixture(connectionId);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  const result = {
    entries: [{ kind: 'file', name: 'file.ts', path: '/remote/file.ts', token: '@file.ts' }],
    truncated: false,
    notice: '',
  };
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return { status: 200, body: { status: 'complete', events: [], result } };
    return original(command, args);
  });
  const location = {
    computerId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    path: '/remote',
  };
  expect(
    await transport.searchMentions({ provider: 'codex', connectionId }, location, 'file', 'fi'),
  ).toEqual(result);
  const call = native.invoke.mock.calls.find(
    ([command, args]) =>
      command === 'relay_request' && args.method === 'POST' && args.path === 'v1/jobs',
  );
  expect(call?.[1].body).toMatchObject({
    method: 'mentions',
    args: { provider: 'codex', connectionId, location, kind: 'file', query: 'fi' },
  });
  expect(native.invoke.mock.calls.some(([command]) => command === 'search_mentions')).toBe(false);
  await transport.disconnectRelay();
  await expect(
    transport.searchMentions({ provider: 'codex', connectionId }, location, 'file', 'fi'),
  ).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'search_mentions')).toBe(false);
});

// A reply was streaming when power was lost. The relay kept a later checkpoint than the
// last sync; the restarted app restored its own saved copy as interrupted.
async function restartedDevice(ownsRun: boolean) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const host = crypto.randomUUID(),
    computerId = crypto.randomUUID(),
    connectionId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computerId, name: 'Host' });
  workspace.fleet.environments.push({ id: host, computerId, name: 'Host', platform: 'windows' });
  workspace.fleet.accounts.push({
    id: accountId,
    provider: 'claude',
    name: 'Host',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: host,
    profile: 'existing',
  });
  const settings = { ...settingsFor(workspace.preferences, 'claude'), connectionId };
  const runId = crypto.randomUUID();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    settings,
    title: 'Outage',
    createdAt: '2026-09-21',
    updatedAt: '2026-09-21',
    location: { computerId, environmentId: host, path: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '2026-09-21',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Build it' }],
      },
      {
        id: crypto.randomUUID(),
        runId,
        role: 'assistant',
        createdAt: '2026-09-21',
        status: 'running',
        settings,
        blocks: [{ type: 'markdown', text: 'Working' }],
      },
    ],
  });
  const base = sharedWorkspace(workspace);
  const remote = structuredClone(base);
  remote.conversations[0].messages[1].blocks = [{ type: 'markdown', text: 'Working on it' }];
  const restored = restoreWorkspace(structuredClone(workspace));
  expect(restored.conversations[0].messages[1]).toMatchObject({
    status: 'cancelled',
    error: interruptedReplyError,
  });
  const applied: SharedWorkspace[] = [];
  transport.configureRuntime({
    installation: {
      id: ownsRun ? host : crypto.randomUUID(),
      computerId: ownsRun ? computerId : crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => restored,
    shared: () => sharedWorkspace(restored),
    ...chatRuntime(() => restored),
    fleet: () => restored.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      applied.push(value);
    },
    checkpointRun: async () => {},
  });
  const puts: SharedWorkspace[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base };
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/state' && args.method === 'GET')
      return { status: 200, body: { instanceId: 'same-relay', workspace: remote, revision: 1 } };
    if (args.path === 'v1/state' && args.method === 'PUT') {
      puts.push(args.body.workspace);
      return {
        status: 200,
        body: { instanceId: 'same-relay', workspace: args.body.workspace, revision: 2 },
      };
    }
    return { status: 200, body: [] };
  });
  expect(await transport.resumeRelay()).toBe(true);
  expect(await transport.pollRelay()).toEqual([]);
  return { puts, applied };
}

it('publishes the restarted execution host’s interrupted reply over a newer running checkpoint', async () => {
  const { puts, applied } = await restartedDevice(true);
  expect(puts).toHaveLength(1);
  const reply = puts[0].conversations[0].messages[1];
  expect(reply).toMatchObject({ status: 'cancelled', error: interruptedReplyError });
  expect(reply.blocks).toEqual([{ type: 'markdown', text: 'Working on it' }]);
  expect(applied.at(-1)?.conversations[0].messages[1]).toMatchObject({
    status: 'cancelled',
    error: interruptedReplyError,
  });
});

it('keeps following a run another computer still executes after this device restarts', async () => {
  const { puts, applied } = await restartedDevice(false);
  expect(puts).toHaveLength(0);
  const reply = applied.at(-1)?.conversations[0].messages[1];
  expect(reply).toMatchObject({ status: 'running' });
  expect(reply?.error).toBeUndefined();
  expect(reply?.blocks).toEqual([{ type: 'markdown', text: 'Working on it' }]);
});

it('saves a host Undo receipt into the live workspace once, including requests from a Viewer', async () => {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const runId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
  workspace.conversations.push({
    id: conversationId,
    title: 'Undo',
    createdAt: '2026-09-19',
    updatedAt: '2026-09-19',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        runId,
        role: 'assistant',
        status: 'complete',
        createdAt: '2026-09-19',
        blocks: [],
      },
    ],
  });
  const apply = vi.fn(async (shared) => {
    workspace.conversations = shared.conversations;
  });
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply,
    checkpointRun: async () => {},
  });
  native.invoke.mockResolvedValue({ files: ['example.txt'], undone: true });
  await transport.undoFiles(conversationId, runId, undefined, true);
  await transport.undoFiles(conversationId, runId, undefined, true);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(workspace.conversations[0].historyRevision).toBe(1);
  expect(workspace.conversations[0].messages[0].filesUndone).toBe(true);
  expect(native.invoke).toHaveBeenCalledWith('undo_files', {
    conversationId,
    runId,
    connectionId: undefined,
    commit: true,
  });
});

async function fixture(remoteConnection?: string) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  if (remoteConnection) {
    const host = crypto.randomUUID(),
      computer = crypto.randomUUID(),
      account = crypto.randomUUID();
    workspace.fleet.computers.push({ id: computer, name: 'Remote' });
    workspace.fleet.environments.push({
      id: host,
      computerId: computer,
      name: 'Remote',
      platform: 'linux',
    });
    workspace.fleet.accounts.push({
      id: account,
      name: 'Remote Gemini',
      provider: 'gemini',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: remoteConnection,
      accountId: account,
      environmentId: host,
      profile: 'existing',
    });
  }
  const shared = sharedWorkspace(workspace);
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base: shared };
    if (command === 'relay_request')
      return {
        status: 200,
        body:
          args.path === 'v1/state'
            ? { instanceId: 'same-relay', workspace: shared, revision: 0 }
            : [],
      };
    return null;
  });
  return transport;
}

it('restores native pairing without sending its key through IPC and resumes heartbeats', async () => {
  const transport = await fixture();
  expect(await transport.resumeRelay()).toBe(true);
  expect(await transport.pollRelay()).toEqual([]);
  expect(native.invoke).toHaveBeenCalledWith('relay_resume');
  expect(native.invoke.mock.calls.some(([command]) => command === 'relay_connect')).toBe(false);
  expect(
    native.invoke.mock.calls.some(
      ([command, args]) => command === 'relay_request' && args.path === 'v1/heartbeat',
    ),
  ).toBe(true);
});

it('routes steering to the original remote connection without starting or falling back to a local run', async () => {
  const connection = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  const input = { id: crypto.randomUUID(), text: 'Check the tests first' };
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return { status: 200, body: { status: 'complete', events: [] } };
    return original(command, args);
  });
  await transport.steerRun(runId, input, connection);
  const call = native.invoke.mock.calls.find(([, args]) => args?.path === 'v1/jobs');
  expect(call?.[1].body.args).toEqual({ runId, input, connectionId: connection });
  expect(call?.[1].body.method).toBe('steer');
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === 'steer_run' || command === 'run_agent',
    ),
  ).toBe(false);
});

it('keeps a pending question when an older relay drops it from a successful save', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const question = {
    id: crypto.randomUUID(),
    revision: 1,
    status: 'pending' as const,
    questions: [
      { id: 'color', header: 'Color', question: 'Choose a color', options: [], multiSelect: false },
    ],
  };
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Waiting for input',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        runId: crypto.randomUUID(),
        status: 'running',
        blocks: [],
        questions: [question],
      },
    ],
  });
  let current: Workspace = workspace;
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => current,
    shared: () => sharedWorkspace(current),
    ...chatRuntime(() => current),
    fleet: () => current.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      current = { ...current, ...value };
    },
    checkpointRun: async () => {},
  });
  const original = native.invoke.getMockImplementation()!;
  let remote = emptyShared();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state') {
      if (args.method === 'PUT') {
        remote = structuredClone(args.body.workspace);
        for (const chat of remote.conversations)
          for (const message of chat.messages) delete message.questions;
      }
      return { status: 200, body: { instanceId: 'same-relay', revision: 0, workspace: remote } };
    }
    return original(command, args);
  });
  await transport.resumeRelay();
  for (let i = 0; i < 3; i++) {
    await transport.pollRelay();
    expect(current.conversations[0].messages[0].questions).toEqual([question]);
    expect(current.conversations[0].messages[0].status).toBe('running');
  }
});

// A paired desktop whose relay keeps revisions like the real one.
async function settledRelay(revisionEndpoint = true) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Settled chat',
    createdAt: '2026-09-24',
    updatedAt: '2026-09-24',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [],
  });
  // A Codex account connected here and on another computer.
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'QA',
    platform: 'windows' as const,
  };
  const peer = crypto.randomUUID(),
    peerComputer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    here = crypto.randomUUID(),
    there = crypto.randomUUID();
  workspace.fleet.computers.push(
    { id: installation.computerId, name: 'QA' },
    { id: peerComputer, name: 'Peer' },
  );
  workspace.fleet.environments.push(
    { id: installation.id, computerId: installation.computerId, name: 'QA', platform: 'windows' },
    { id: peer, computerId: peerComputer, name: 'Peer', platform: 'linux' },
  );
  workspace.fleet.accounts.push({
    id: account,
    provider: 'codex',
    name: 'Codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push(
    { id: here, accountId: account, environmentId: installation.id, profile: 'existing' },
    { id: there, accountId: account, environmentId: peer, profile: 'existing' },
  );
  const local = { changes: 0, reads: 0, runs: [] as string[] };
  const apply = vi.fn(async (value: SharedWorkspace) => {
    Object.assign(workspace, value);
  });
  transport.configureRuntime({
    installation,
    workspace: () => {
      local.reads++;
      return workspace;
    },
    shared: () => {
      local.reads++;
      return sharedWorkspace(workspace);
    },
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    revision: () => local.changes,
    statuses: () => ({}),
    localRuns: () => local.runs,
    apply,
    checkpointRun: async () => {},
  });
  const relay = { revision: 5, workspace: sharedWorkspace(workspace), presence: [] as unknown[] };
  const requests: string[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base: relay.workspace };
    if (command === 'save_sync_state') requests.push('save_sync_state');
    if (command !== 'relay_request') return null;
    requests.push(`${args.method} ${args.path}`);
    // A relay without the incremental routes. Its whole-state path is what these cases cover.
    if (args.path.startsWith('v1/state/manifest'))
      return { status: 404, body: { error: 'Unknown relay operation.' } };
    if (args.path === 'v1/state/revision')
      return revisionEndpoint
        ? { status: 200, body: { instanceId: 'same-relay', revision: relay.revision } }
        : { status: 404, body: { error: 'Unknown relay operation.' } };
    if (args.path === 'v1/state' && args.method === 'PUT') {
      relay.revision++;
      relay.workspace = args.body.workspace;
    }
    if (args.path === 'v1/state')
      return {
        status: 200,
        body: { instanceId: 'same-relay', revision: relay.revision, workspace: relay.workspace },
      };
    return { status: 200, body: args.path === 'v1/heartbeat' ? relay.presence : [] };
  });
  expect(await transport.resumeRelay()).toBe(true);
  // The first poll syncs the whole workspace and finds both sides equal.
  expect(await transport.pollRelay()).toEqual([]);
  expect(requests.filter((r) => r.includes('state'))).toEqual([
    'GET v1/state',
    'GET v1/state',
    'save_sync_state',
  ]);
  // One more poll asks this relay for a manifest once and learns it has none.
  expect(await transport.pollRelay()).toEqual([]);
  expect(requests.filter((r) => r === 'GET v1/state/manifest')).toHaveLength(1);
  requests.length = 0;
  const polls = async (count: number) => {
    const reads = local.reads;
    requests.length = 0;
    for (let i = 0; i < count; i++) expect(await transport.pollRelay()).not.toBeNull();
    return { state: requests.filter((r) => r.includes('state')), reads: local.reads - reads };
  };
  return { transport, workspace, relay, local, apply, requests, polls, here, there, peer };
}

it('polls after an unchanged sync only ask the relay for its revision', async () => {
  const { transport, apply, requests, polls } = await settledRelay();
  expect(await polls(3)).toEqual({ state: Array(3).fill('GET v1/state/revision'), reads: 0 });
  // Presence and jobs still run every poll.
  expect(requests.filter((r) => r === 'POST v1/heartbeat')).toHaveLength(3);
  expect(requests.filter((r) => r === 'GET v1/jobs')).toHaveLength(3);
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('syncs a change from either side, then returns to revision checks', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].title).toBe('Renamed here');
  expect(apply).not.toHaveBeenCalled();
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // Another device renames the chat.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'GET v1/state',
    'save_sync_state',
  ]);
  expect(apply).toHaveBeenCalledOnce();
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  // One more sync confirms both sides are equal; the checkpoint is already saved.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  expect(apply).toHaveBeenCalledOnce();
  await transport.disconnectRelay();
});

it('settles after sending a new chat that the relay lists in another order', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  // This device lists a new chat first; the merge appends it after the relay's chats.
  workspace.conversations.unshift({
    ...workspace.conversations[0],
    id: crypto.randomUUID(),
    title: 'New chat',
  });
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations.map((c) => c.title)).toEqual(['Settled chat', 'New chat']);
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  expect(apply).not.toHaveBeenCalled();
  expect(workspace.conversations.map((c) => c.title)).toEqual(['New chat', 'Settled chat']);
  await transport.disconnectRelay();
});

const appSession = (hour: number) => ({
  id: crypto.randomUUID(),
  environmentId: crypto.randomUUID(),
  startedAt: new Date(2026, 8, 25, hour).toISOString(),
});

it('keeps app sessions that an older relay drops without sending them after every sync', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: { ...args.body, workspace: { ...args.body.workspace, appSessions: undefined } },
          }
        : args,
    ),
  );
  const session = appSession(9);
  workspace.appSessions = [session];
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].title).toBe('Renamed here');
  expect(relay.workspace.appSessions).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the list here.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'GET v1/state',
    'save_sync_state',
  ]);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.appSessions).toEqual([session]);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it('sends app sessions to a relay that keeps them', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const [first, second] = [appSession(9), appSession(14)];
  workspace.appSessions = [first];
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.appSessions).toEqual([first]);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // Once the relay holds the list, another start of the app is sent by itself.
  workspace.appSessions = [first, second];
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.appSessions).toEqual([first, second]);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('routes requests and account updates with the fleet alone, never a workspace copy', async () => {
  const { transport, relay, local, polls, here, there, peer } = await settledRelay();
  const reads = local.reads;
  await transport.readUsage('codex', '', false, here);
  expect(local.reads).toBe(reads);
  // Every heartbeat can carry other computers' live account usage.
  relay.presence = [
    {
      environmentId: peer,
      online: true,
      seenAt: Date.now(),
      connections: [],
      accountUpdates: [
        {
          connectionId: there,
          epoch: crypto.randomUUID(),
          revision: 1,
          accountChanged: 0,
          authMode: null,
          planType: null,
          creditsCheckedAt: null,
          limitStatus: null,
          snapshot: {
            provider: 'codex',
            checkedAt: Math.floor(Date.now() / 1000),
            windows: [],
            credits: null,
            context: null,
            detail: '',
          },
        },
      ],
    },
  ];
  expect((await polls(2)).reads).toBe(0);
  await transport.disconnectRelay();
});

it('gets the state from relays without the revision endpoint without syncing it again', async () => {
  // The manifest and revision probes were both answered 404 by the fixture's warm-up poll.
  const { transport, apply, polls } = await settledRelay(false);
  expect(await polls(3)).toEqual({ state: Array(3).fill('GET v1/state'), reads: 0 });
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('publishes a running reply every poll without downloading the relay copy', async () => {
  const { transport, workspace, relay, local, polls } = await settledRelay();
  local.runs.push(crypto.randomUUID());
  // A reply changes this device between polls, and every poll sends its progress on.
  for (const title of ['Progress 1', 'Progress 2']) {
    workspace.conversations[0].title = title;
    local.changes++;
    // The relay still holds the baseline, so its revision answers instead of the whole state,
    // and rewriting the whole checkpoint waits until the reply has run for a while.
    expect((await polls(1)).state).toEqual(['GET v1/state/revision', 'PUT v1/state']);
    expect(relay.workspace.conversations[0].title).toBe(title);
  }
  // A reply waiting on a long tool call changes nothing, so its polls read nothing either.
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  // Once the interval passes, the next poll of the reply saves the checkpoint again.
  vi.setSystemTime(Date.now() + 20_000);
  workspace.conversations[0].title = 'Progress 3';
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  vi.useRealTimers();
  local.runs.length = 0;
  await transport.disconnectRelay();
});

it('syncs and saves a workspace past the former 20 MB limit', async () => {
  const { transport, workspace, relay, local, polls } = await settledRelay();
  // Comfortably past the limit this app and its relay used to reject.
  workspace.conversations[0].messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    createdAt: '2026-09-26',
    status: 'complete',
    blocks: [{ type: 'markdown', text: 'x'.repeat(25_000_000) }],
  });
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].messages).toHaveLength(1);
  expect(JSON.stringify(relay.workspace).length).toBeGreaterThan(20_000_000);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  await transport.disconnectRelay();
});

// A relay with per-conversation revisions, so a poll publishes and takes in only what moved.
async function incrementalRelay() {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const chat = (title: string) => ({
    id: crypto.randomUUID(),
    title,
    createdAt: '2026-09-26',
    updatedAt: '2026-09-26',
    settings: { provider: 'codex' as const, model: '', reasoning: '' as const, instructions: '' },
    messages: [],
  });
  workspace.conversations.push(chat('First'), chat('Second'));
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'QA',
    platform: 'windows' as const,
  };
  workspace.fleet.computers.push({ id: installation.computerId, name: 'QA' });
  workspace.fleet.environments.push({
    id: installation.id,
    computerId: installation.computerId,
    name: 'QA',
    platform: 'windows',
  });
  const local = { changes: 0, reads: 0, runs: [] as string[] };
  const marks = chatMarks();
  transport.configureRuntime({
    installation,
    workspace: () => {
      local.reads++;
      return workspace;
    },
    shared: () => {
      local.reads++;
      return sharedWorkspace(workspace);
    },
    ...chatRuntime(() => workspace, marks),
    fleet: () => workspace.fleet,
    revision: () => local.changes,
    statuses: () => ({}),
    localRuns: () => local.runs,
    apply: async (value) => {
      local.reads++;
      Object.assign(workspace, value);
    },
    checkpointRun: async () => {},
  });
  // The relay's own copy, with the revision that last changed each part of it.
  const relay = {
    revision: 5,
    metaRevision: 5,
    workspace: sharedWorkspace(workspace),
    chats: Object.fromEntries(workspace.conversations.map((c) => [c.id, 5])),
  };
  const requests: string[] = [];
  const manifest = () => ({
    instanceId: 'same-relay',
    revision: relay.revision,
    metaRevision: relay.metaRevision,
    chats: relay.chats,
  });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base: relay.workspace };
    if (command === 'save_sync_state') requests.push('save_sync_state');
    if (command !== 'relay_request') return null;
    requests.push(`${args.method} ${args.path}`);
    if (args.path === 'v1/state/manifest') return { status: 200, body: manifest() };
    if (args.path === 'v1/state/meta') {
      const { conversations, ...meta } = relay.workspace;
      return { status: 200, body: { ...manifest(), meta } };
    }
    if (args.path === 'v1/state/chats') {
      const wanted = new Set(args.body.ids);
      return {
        status: 200,
        body: {
          ...manifest(),
          chats: relay.workspace.conversations.filter((c) => wanted.has(c.id)),
          chatRevisions: relay.chats,
        },
      };
    }
    if (args.path === 'v1/state/patch') {
      if (args.body.revision !== relay.revision) return { status: 409, body: manifest() };
      relay.revision++;
      const conversations = relay.workspace.conversations.filter(
        (c) => !(args.body.remove ?? []).includes(c.id),
      );
      for (const id of args.body.remove ?? []) delete relay.chats[id];
      for (const incoming of args.body.upsert ?? []) {
        const at = conversations.findIndex((c) => c.id === incoming.id);
        if (at >= 0) conversations[at] = incoming;
        else conversations.push(incoming);
        relay.chats[incoming.id] = relay.revision;
      }
      if (args.body.meta) {
        relay.workspace = { ...args.body.meta, conversations };
        relay.metaRevision = relay.revision;
      } else relay.workspace = { ...relay.workspace, conversations };
      return { status: 200, body: manifest() };
    }
    if (args.path === 'v1/state/revision')
      return { status: 200, body: { instanceId: 'same-relay', revision: relay.revision } };
    if (args.path === 'v1/state')
      return {
        status: 200,
        body: {
          instanceId: 'same-relay',
          revision: relay.revision,
          workspace: relay.workspace,
          chatRevisions: relay.chats,
          metaRevision: relay.metaRevision,
        },
      };
    return { status: 200, body: args.path === 'v1/heartbeat' ? [] : [] };
  });
  expect(await transport.resumeRelay()).toBe(true);
  // The first poll takes the whole-state path and learns the relay's per-conversation revisions.
  expect(await transport.pollRelay()).toEqual([]);
  const polls = async (count: number) => {
    const reads = local.reads;
    requests.length = 0;
    for (let i = 0; i < count; i++) expect(await transport.pollRelay()).not.toBeNull();
    return { state: requests.filter((r) => r.includes('state')), reads: local.reads - reads };
  };
  return { transport, workspace, relay, local, requests, polls, marks };
}

it('publishes only the conversation that changed, and takes in only what moved', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  // Settled: the manifest alone answers, and nothing here is copied or validated whole.
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/manifest'), reads: 0 });

  // One conversation changes here. Only it is sent, and the other is never downloaded.
  const [first, second] = workspace.conversations;
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  expect((await polls(1)).state).toEqual([
    'GET v1/state/manifest',
    'POST v1/state/patch',
    'save_sync_state',
  ]);
  const sent = relay.workspace.conversations.find((c) => c.id === first.id);
  expect(sent?.title).toBe('Renamed here');
  expect(relay.chats[first.id]).toBeGreaterThan(relay.chats[second.id]);
  expect(await polls(1)).toEqual({ state: ['GET v1/state/manifest'], reads: 0 });

  // Another device renames the other conversation. Only that one is fetched.
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) =>
      c.id === second.id ? { ...c, title: 'Renamed elsewhere' } : c,
    ),
  };
  relay.chats[second.id] = relay.revision;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/manifest',
    'POST v1/state/chats',
    'save_sync_state',
  ]);
  expect(workspace.conversations.find((c) => c.id === second.id)?.title).toBe('Renamed elsewhere');
  expect(workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Renamed here');
  expect(await polls(1)).toEqual({ state: ['GET v1/state/manifest'], reads: 0 });
  await transport.disconnectRelay();
});

it('sends replicated settings only when they move, and deletes on both sides', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  // A computer added here belongs to the settings the relay keeps beside its conversations.
  workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Laptop' });
  local.changes++;
  marks.mark();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/manifest',
    'POST v1/state/patch',
    'save_sync_state',
  ]);
  expect(relay.workspace.fleet.computers.map((c) => c.name)).toEqual(['QA', 'Laptop']);
  expect(relay.metaRevision).toBe(relay.revision);

  // A conversation deleted here is removed there, and one deleted there disappears here.
  const [first, second] = workspace.conversations;
  workspace.conversations = workspace.conversations.filter((c) => c.id !== first.id);
  local.changes++;
  marks.mark();
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(relay.workspace.conversations.map((c) => c.id)).toEqual([second.id]);
  expect(relay.chats[first.id]).toBeUndefined();
  relay.revision++;
  relay.workspace = { ...relay.workspace, conversations: [] };
  delete relay.chats[second.id];
  expect((await polls(1)).state).toContain('GET v1/state/manifest');
  expect(workspace.conversations).toEqual([]);
  await transport.disconnectRelay();
});

it('keeps a conversation unpublished when another device wrote first', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first] = workspace.conversations;
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  // The relay moves between this poll's manifest and its patch, so the patch is refused.
  const original = native.invoke.getMockImplementation()!;
  let moved = false;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state/patch' && !moved) {
      moved = true;
      relay.revision++;
      return original(command, { ...args, body: { ...args.body, revision: -1 } });
    }
    return original(command, args);
  });
  expect((await polls(1)).state).toEqual(['GET v1/state/manifest', 'POST v1/state/patch']);
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('First');
  // The next poll tries again with a fresh manifest and the change is still there.
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Renamed here');
  await transport.disconnectRelay();
});

it('deletion waits for the remote response to stop and merges its final checkpoint', async () => {
  const connection = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  const order: string[] = [];
  let reads = 0;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request') {
      if (args.path === `v1/jobs/${runId}/cancel`) {
        order.push('cancel');
        return { status: 200, body: {} };
      }
      if (args.path === `v1/jobs/${runId}`) {
        const status = ++reads === 1 ? 'running' : 'cancelled';
        order.push(status);
        return { status: 200, body: { status } };
      }
      if (args.path === 'v1/state') order.push('checkpoint');
    }
    return original(command, args);
  });
  await transport.cancelRun(runId, connection, true);
  expect(order).toEqual(['cancel', 'running', 'cancelled', 'checkpoint']);
  expect(native.invoke.mock.calls.some(([command]) => command === 'cancel_run')).toBe(false);
});

it('a remote cancellation error never falls back to stopping a local run', async () => {
  const connection = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  native.invoke.mockResolvedValueOnce({ status: 503, body: { error: 'Host unavailable' } });
  await expect(transport.cancelRun(crypto.randomUUID(), connection, true)).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'cancel_run')).toBe(false);
});

it('leaves an unpaired desktop local and retries a temporary startup outage', async () => {
  const transport = await fixture();
  native.invoke.mockResolvedValueOnce(null);
  expect(await transport.resumeRelay()).toBe(false);
  native.invoke.mockRejectedValueOnce('Cannot connect to the relay');
  await expect(transport.resumeRelay()).rejects.toBe('Cannot connect to the relay');
  expect(await transport.resumeRelay()).toBe(true);
});

it('does not silently merge a replaced relay during automatic restoration', async () => {
  const transport = await fixture();
  native.invoke
    .mockResolvedValueOnce('https://relay.example.com/')
    .mockResolvedValueOnce({ status: 200, body: { instanceId: 'replacement' } });
  await expect(transport.resumeRelay()).rejects.toThrow('Relay data was replaced');
  expect(await transport.pollRelay()).toBeNull();
  expect(native.invoke.mock.calls.some(([, args]) => args?.method === 'PUT')).toBe(false);
});

it('an explicit disconnect wins over a late restoration', async () => {
  const transport = await fixture();
  let finish!: (value: string) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transport.resumeRelay();
  await transport.disconnectRelay();
  finish('https://relay.example.com/');
  expect(await pending).toBe(false);
  expect(await transport.pollRelay()).toBeNull();
  expect(native.invoke).toHaveBeenCalledWith('relay_disconnect');
});

it('failed forgetting keeps the existing connection available for a retry', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  native.invoke.mockRejectedValueOnce('Cannot remove saved pairing');
  await expect(transport.disconnectRelay()).rejects.toBe('Cannot remove saved pairing');
  expect(await transport.pollRelay()).toEqual([]);
});

it('hides administration for older relays without hiding mutation errors', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  native.invoke.mockResolvedValueOnce({ status: 404, body: { error: 'Not found' } });
  expect(await transport.readWorkspaceAdministration()).toBeNull();
  native.invoke.mockResolvedValueOnce({
    status: 404,
    body: { error: 'Workspace not found', code: 'workspace_not_found' },
  });
  await expect(transport.updateManagedWorkspace('missing', 'Name', 'member')).rejects.toMatchObject(
    { status: 404, code: 'workspace_not_found' },
  );
});

it('uses typed private administration requests without persisting newly issued keys', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  const workspace = {
    id: crypto.randomUUID(),
    name: 'Member workspace',
    role: 'member' as const,
    enabled: true,
    createdAt: Date.now(),
  };
  native.invoke.mockResolvedValueOnce({
    status: 201,
    body: { workspace, token: 'synthetic-issued-private-workspace-key' },
  });
  const result = await transport.createManagedWorkspace(workspace.name, workspace.role);
  expect(result?.workspace).toEqual(workspace);
  expect(result?.token).toBe('synthetic-issued-private-workspace-key');
  expect(native.invoke).toHaveBeenLastCalledWith('relay_request', {
    method: 'POST',
    path: 'v1/workspace-admin/workspaces',
    body: { name: workspace.name, role: 'member' },
  });
  expect(
    native.invoke.mock.calls.some(([command]) =>
      ['save_workspace', 'save_sync_state'].includes(command),
    ),
  ).toBe(false);
  native.invoke.mockResolvedValueOnce({
    status: 403,
    body: { error: 'An administrator role is required.', code: 'admin_required' },
  });
  await expect(transport.disableManagedWorkspace(workspace.id)).rejects.toMatchObject({
    status: 403,
    code: 'admin_required',
  });
});

it('discards a late native administration key after the connection changes', async () => {
  const transport = await fixture();
  const connectionChanges: boolean[] = [];
  const stopWatching = transport.watchRelayConnection((ready) => connectionChanges.push(ready));
  await transport.resumeRelay();
  let finish!: (response: unknown) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transport.rotateManagedWorkspaceKey(crypto.randomUUID());
  const rejected = expect(pending).rejects.toMatchObject({
    message: 'The private workspace connection changed.',
    status: 401,
  });
  await transport.disconnectRelay();
  finish({ status: 200, body: { token: 'synthetic-secret-must-not-reach-the-old-view' } });
  await rejected;
  expect(transport.relayConnectionGeneration()).toBeNull();
  await expect(transport.readWorkspaceAdministration()).rejects.toMatchObject({ status: 401 });
  expect(connectionChanges).toEqual([true, false]);
  stopWatching();
  await transport.resumeRelay();
  expect(connectionChanges).toEqual([true, false]);
});
