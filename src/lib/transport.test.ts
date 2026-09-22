import { beforeEach, expect, it, vi } from 'vitest';
import {
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Workspace,
} from './domain';
import { emptyShared, sharedWorkspace, type SharedWorkspace } from './sync';

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
