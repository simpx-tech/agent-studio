import { beforeEach, expect, it, vi } from 'vitest';
import { initialWorkspace } from './domain';
import { emptyShared, sharedWorkspace } from './sync';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  isTauri: () => true,
  Channel: class {},
}));

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
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
