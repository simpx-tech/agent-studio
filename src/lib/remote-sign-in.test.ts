import { beforeEach, expect, it, vi } from 'vitest';
import { initialWorkspace, type Workspace } from './domain';
import { sharedChatSchema, sharedMeta, sharedWorkspace } from './sync';
import type { SignInView } from './sign-in';

// A computer's sign-ins opened from another device travel through the relay's jobs
// (src-tauri/src/sign_in.rs): the page and code to that device, a pasted code back.
const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  isTauri: () => true,
  Channel: class {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, handler);
    return () => native.listeners.delete(name);
  },
}));

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  native.listeners.clear();
});

// A server running one Codex account.
function serverFleet() {
  const workspace = initialWorkspace();
  const server = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    codex = crypto.randomUUID(),
    account = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computer, name: 'VPS' });
  workspace.fleet.environments.push({
    id: server,
    computerId: computer,
    name: 'Linux',
    platform: 'linux',
  });
  workspace.fleet.accounts.push({
    id: account,
    provider: 'codex',
    name: 'Codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: codex,
    accountId: account,
    environmentId: server,
    profile: 'existing',
  });
  return { workspace, server, computer, codex };
}

// This app, paired, as the computer `installation` names.
async function paired(workspace: Workspace, installation: { id: string; computerId: string }) {
  const transport = await import('./transport');
  transport.configureRuntime({
    installation: { ...installation, name: 'QA', platform: 'linux' },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    chat: (id) => {
      const conversation = workspace.conversations.find((c) => c.id === id);
      return conversation && sharedChatSchema.parse(conversation);
    },
    chatIds: () => workspace.conversations.map((c) => c.id),
    meta: () => sharedMeta(workspace),
    takeUnsynced: () => ({ chats: new Set(), meta: false }),
    restoreUnsynced: () => {},
    applyChats: async () => {},
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  return transport;
}

const relayAnswer = (workspace: Workspace, path: string) => ({
  status: 200,
  body:
    path === 'v1/state'
      ? { instanceId: 'same-relay', workspace: sharedWorkspace(workspace), revision: 0 }
      : [],
});

const view = (patch: Partial<SignInView>): SignInView => ({
  id: crypto.randomUUID(),
  provider: 'codex',
  phase: 'waiting',
  url: 'https://auth.openai.com/codex/device',
  code: false,
  codeExpected: false,
  userCode: 'ABCD-12345',
  message: 'Open the sign-in page and enter this code.',
  ...patch,
});

it('opens a sign-in on the computer that runs the account and follows it to its end', async () => {
  const { workspace, codex } = serverFleet();
  const transport = await paired(workspace, {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
  });
  const waiting = view({ connectionId: codex });
  const states = [
    { status: 'running', events: [waiting] },
    { status: 'running', events: [{ ...waiting, message: 'Still waiting' }] },
    {
      status: 'complete',
      events: [],
      result: { ...waiting, phase: 'connected', url: undefined, userCode: undefined, message: '' },
    },
  ];
  const posted: any[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/jobs' && args.method === 'POST') {
      posted.push(args.body);
      return { status: 200, body: {} };
    }
    if (args.path.endsWith('/cancel')) {
      posted.push({ cancelled: args.path });
      return { status: 200, body: {} };
    }
    if (args.path.startsWith('v1/jobs/') && args.method === 'GET') {
      const job = posted.find((p) => args.path === `v1/jobs/${p.id}`);
      if (job?.method === 'signInCode')
        return {
          status: 200,
          body: { status: 'complete', events: [], result: { ...waiting, message: 'Checking…' } },
        };
      return { status: 200, body: states.length > 1 ? states.shift() : states[0] };
    }
    return relayAnswer(workspace, args.path);
  });
  expect(await transport.resumeRelay()).toBe(true);
  const updates: SignInView[] = [];
  const first = await transport.signIn('codex', codex, (update) => updates.push(update));
  expect(first).toEqual(waiting);
  expect(posted[0]).toMatchObject({
    method: 'signIn',
    args: { provider: 'codex', connectionId: codex },
  });
  // Nothing signs in on this computer for it.
  expect(native.invoke.mock.calls.some(([command]) => command === 'sign_in')).toBe(false);
  // A code goes to the sign-in on its computer, and Cancel to its job.
  expect((await transport.submitSignInCode(waiting.id, 'good#state')).message).toBe('Checking…');
  expect(posted[1]).toMatchObject({
    method: 'signInCode',
    args: { connectionId: codex, id: waiting.id, code: 'good#state' },
  });
  await transport.cancelSignIn(waiting.id);
  expect(posted.at(-1)).toEqual({ cancelled: `v1/jobs/${posted[0].id}/cancel` });
  await vi.waitFor(() => expect(updates.at(-1)?.phase).toBe('connected'), { timeout: 5000 });
  expect(updates.map((u) => u.message)).toContain('Still waiting');
  await transport.disconnectRelay();
});

// The server runs `job` for another device, and answers each of its updates with `cancel`.
async function serverRuns(
  job: { id: string; method: string; args: Record<string, unknown> },
  cancel = false,
) {
  const fleet = serverFleet();
  job.args.connectionId = fleet.codex;
  const transport = await paired(fleet.workspace, { id: fleet.server, computerId: fleet.computer });
  const updates: any[] = [];
  let claimed = false;
  const started = view({ connectionId: fleet.codex });
  const ended = (phase: SignInView['phase']) =>
    native.listeners.get('studio-sign-in')?.({
      payload: { ...started, phase, url: undefined, userCode: undefined, message: '' },
    });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'sign_in') {
      // This computer's own windows hear of it first, as they do from the host.
      native.listeners.get('studio-sign-in')?.({ payload: started });
      return started;
    }
    if (command === 'sign_ins') return [started];
    if (command === 'sign_in_code') return { ...started, message: 'Checking…' };
    if (command === 'cancel_sign_in') {
      ended('cancelled');
      return null;
    }
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/jobs' && args.method === 'GET') {
      const jobs = claimed ? [] : [job];
      claimed = true;
      return { status: 200, body: jobs };
    }
    if (args.path === `v1/jobs/${job.id}` && args.method === 'PUT') {
      updates.push(structuredClone(args.body));
      return { status: 200, body: { cancel } };
    }
    return relayAnswer(fleet.workspace, args.path);
  });
  await transport.resumeRelay();
  await transport.pollRelay();
  return { transport, updates, started, ended };
}

it('runs a sign-in another device opened without opening anything here, until it ends', async () => {
  const job = {
    id: crypto.randomUUID(),
    method: 'signIn',
    args: { provider: 'codex' } as Record<string, unknown>,
  };
  const { transport, updates, started, ended } = await serverRuns(job);
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('sign_in', {
      provider: 'codex',
      connectionId: job.args.connectionId,
      remote: true,
    }),
  );
  await vi.waitFor(() => expect(updates.at(-1)?.events).toEqual([started]));
  ended('connected');
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('complete'));
  expect(updates.at(-1).result).toMatchObject({ id: started.id, phase: 'connected' });
  // One event, the latest state.
  expect(updates.at(-1).events).toHaveLength(1);
  await transport.disconnectRelay();
});

it('stops a sign-in when the device that opened it cancels', async () => {
  const job = { id: crypto.randomUUID(), method: 'signIn', args: { provider: 'codex' } };
  const { transport, updates, started } = await serverRuns(job, true);
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('cancel_sign_in', { id: started.id }),
  );
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('complete'));
  expect(updates.at(-1).result).toMatchObject({ phase: 'cancelled' });
  await transport.disconnectRelay();
});

it('takes a code only for a sign-in waiting for that connection', async () => {
  const job = {
    id: crypto.randomUUID(),
    method: 'signInCode',
    args: { id: crypto.randomUUID(), code: 'good#state' },
  };
  const { transport, updates } = await serverRuns(job);
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('error'));
  expect(updates.at(-1).error).toContain('This sign-in has ended');
  expect(native.invoke.mock.calls.some(([command]) => command === 'sign_in_code')).toBe(false);
  await transport.disconnectRelay();
});
