import { afterEach, describe, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import {
  createWorkspace,
  disableWorkspace,
  listWorkspaces,
  rotateWorkspace,
} from '../../relay/workspaces.ts';
import { emptyShared } from './sync';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-private-workspaces-'));
  const token = 'synthetic-owner-workspace-test-key-'.repeat(2);
  let time = Date.now();
  let pausedPush: Promise<void> | undefined;
  let completedPushes = 0;
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const options = {
    token,
    directory,
    now: () => time,
    pushSender: async (subscription: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      const paused = pausedPush;
      pausedPush = undefined;
      await paused;
      completedPushes++;
    },
  };
  let server = createRelay(options);
  server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const source = crypto.randomUUID();
  const target = crypto.randomUUID();
  const alice = createWorkspace({ directory, name: 'Alice private', now: () => time });
  const bob = createWorkspace({ directory, name: 'Bob private', now: () => time });
  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const call = (
    key: string,
    method: string,
    path: string,
    body?: unknown,
    actor = source,
    extra: Record<string, string> = {},
  ) =>
    request(method, path, body, {
      authorization: `Bearer ${key}`,
      'x-environment-id': actor,
      ...extra,
    });
  async function pair(key: string, actor = source, cookie?: string) {
    const response = await request(
      'POST',
      'browser-session',
      { token: key, environmentId: actor },
      { origin: url, ...(cookie ? { cookie } : {}) },
    );
    expect(response.status).toBe(200);
    const sessionCookie = response.headers.get('set-cookie')!.split(';')[0];
    return {
      ...response.body,
      cookie: sessionCookie,
      headers: {
        origin: url,
        cookie: sessionCookie,
        'x-environment-id': actor,
        'x-workspace-id': response.body.workspaceId,
      } as Record<string, string>,
    };
  }
  const heartbeat = (key: string, actor = target) =>
    call(key, 'POST', 'heartbeat', { environmentId: actor, connections: [], running: [] }, actor);
  const restart = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createRelay(options);
    server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  };
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    token,
    alice,
    bob,
    source,
    target,
    request,
    call,
    pair,
    heartbeat,
    restart,
    sent,
    get completedPushes() {
      return completedPushes;
    },
    pauseNextPush() {
      let resume!: () => void;
      pausedPush = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
    async stalledWrite(headers: Record<string, string>, workspace: ReturnType<typeof emptyShared>) {
      let release!: () => void;
      const received = new Promise<void>((resolve) => server.once('request', () => resolve()));
      const completed = new Promise<{ status: number; body: any }>((resolve, reject) => {
        const request = httpRequest(
          `${url}/v1/state`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...headers },
          },
          (response) => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              data += chunk;
            });
            response.on('end', () =>
              resolve({ status: response.statusCode!, body: JSON.parse(data) }),
            );
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.write('{"revision":0,"workspace":');
        release = () => request.end(`${JSON.stringify(workspace)}}`);
      });
      await received;
      return { release, completed };
    },
    advance: (ms: number) => (time += ms),
  };
}

// Reusing all IDs is intentional: IDs identify resources within a workspace,
// never authority to access a resource in another person's workspace.
function privateState(name: string, source: string, target: string) {
  const workspace = emptyShared();
  workspace.fleet.computers.push({ id: source, name: `${name} computer` });
  workspace.fleet.environments.push({
    id: target,
    computerId: source,
    name: `${name} environment`,
    platform: 'linux',
  });
  workspace.fleet.accounts.push({
    id: source,
    name: `${name} account`,
    provider: 'codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: source,
    accountId: source,
    environmentId: target,
    profile: 'existing',
  });
  workspace.conversations.push({
    id: source,
    title: `${name} confidential chat`,
    settings: {
      connectionId: source,
      provider: 'codex',
      model: '',
      reasoning: '',
      instructions: `${name} private instructions`,
    },
    location: { computerId: source, environmentId: target, path: `/home/${name}/project` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: target,
        runId: target,
        role: 'assistant',
        status: 'running',
        createdAt: new Date().toISOString(),
        blocks: [{ type: 'markdown', text: `${name} private answer` }],
      },
    ],
  });
  return workspace;
}

describe('private relay workspaces over real HTTP', () => {
  it('runs local workspace administration with plain Node and lists only public metadata', async () => {
    const f = await fixture();
    const command = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, ['relay/manage.ts', ...args], {
          cwd: process.cwd(),
          env: { ...process.env, AGENT_STUDIO_RELAY_DATA: f.directory },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    const created = command('create', 'CLI private user');
    expect(created.token.length).toBeGreaterThanOrEqual(32);
    expect((await f.call(created.token, 'GET', 'state')).body.workspace).toEqual(emptyShared());
    const publicList = command('list');
    expect(publicList.find((entry: { id: string }) => entry.id === created.workspace.id)).toEqual(
      created.workspace,
    );
    expect(JSON.stringify(publicList)).not.toContain(created.token);
    expect(JSON.stringify(publicList)).not.toContain('sessionSecret');
    expect(JSON.stringify(publicList)).not.toContain('tokenHash');
    const rotated = command('rotate', created.workspace.id);
    expect(rotated.token).not.toBe(created.token);
    expect((await f.call(created.token, 'GET', 'state')).status).toBe(401);
    expect((await f.call(rotated.token, 'GET', 'state')).status).toBe(200);
    const disabled = command('disable', created.workspace.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled).not.toHaveProperty('token');
    expect((await f.call(rotated.token, 'GET', 'state')).status).toBe(401);
    const registry = readFileSync(join(f.directory, 'workspaces.json'), 'utf8');
    expect(registry).not.toContain(created.token);
    expect(registry).not.toContain(rotated.token);
  });

  it('isolates owner and guest state, revisions, fleet, account setup, chats, and durable identity', async () => {
    const f = await fixture();
    const values = [
      { key: f.token, id: 'owner', name: 'Owner' },
      { key: f.alice.token, id: f.alice.workspace.id, name: 'Alice' },
      { key: f.bob.token, id: f.bob.workspace.id, name: 'Bob' },
    ];
    const identities = new Set<string>();
    const snapshots = new Map(
      values.map((person) => [person.id, privateState(person.name, f.source, f.target)]),
    );
    for (const person of values) {
      const initial = await f.call(person.key, 'GET', 'state');
      expect(initial.status).toBe(200);
      expect(initial.body.workspaceId).toBe(person.id);
      expect(initial.body.workspace).toEqual(emptyShared());
      identities.add(initial.body.instanceId);
      const result = await f.call(person.key, 'PUT', 'state', {
        revision: 0,
        workspace: snapshots.get(person.id),
      });
      expect(result.status).toBe(200);
      expect(result.body.revision).toBe(1);
    }
    expect(identities.size).toBe(3);
    await f.restart();
    for (const person of values) {
      const result = await f.call(person.key, 'GET', 'state');
      expect(result.body.workspaceId).toBe(person.id);
      expect(result.body.workspace).toEqual(snapshots.get(person.id));
      expect(identities.has(result.body.instanceId)).toBe(true);
      for (const other of values.filter((value) => value !== person))
        expect(JSON.stringify(result.body)).not.toContain(other.name);
      const conflict = await f.call(person.key, 'PUT', 'state', {
        revision: 0,
        workspace: emptyShared(),
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.workspaceId).toBe(person.id);
      expect(conflict.body.workspace.conversations[0].title).toContain(person.name);
    }
    const publicList = JSON.stringify(listWorkspaces(f.directory));
    expect(publicList).not.toContain(f.alice.token);
    expect(publicList).not.toContain(f.bob.token);
    expect(publicList).not.toContain('confidential');
    const diskFiles = readdirSync(f.directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    for (const content of diskFiles) {
      expect(content).not.toContain(f.token);
      expect(content).not.toContain(f.alice.token);
      expect(content).not.toContain(f.bob.token);
    }
  });

  it('does not expose another workspace through guessed headers, state paths, or management endpoints', async () => {
    const f = await fixture();
    await f.call(f.alice.token, 'PUT', 'state', {
      revision: 0,
      workspace: privateState('Alice', f.source, f.target),
    });
    const mismatch = await f.call(f.bob.token, 'GET', 'state', undefined, f.source, {
      'x-workspace-id': f.alice.workspace.id,
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('workspace_changed');
    expect(JSON.stringify(mismatch.body)).not.toContain('Alice');
    for (const path of [
      `workspaces/${f.alice.workspace.id}/state`,
      'workspaces',
      'admin/workspaces',
      `state?workspaceId=${f.alice.workspace.id}`,
    ]) {
      const result = await f.call(f.bob.token, 'GET', path);
      expect(JSON.stringify(result.body)).not.toContain('Alice');
      if (path.includes('?')) expect(result.body.workspaceId).toBe(f.bob.workspace.id);
      else expect(result.status).toBe(404);
    }
  });

  it('keeps presence, claims, events, results, cancellation, and reused job IDs local to each workspace', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await f.heartbeat(f.alice.token);
    const bobPresence = await f.heartbeat(f.bob.token, f.source);
    expect(bobPresence.body.map((peer: { environmentId: string }) => peer.environmentId)).toEqual([
      f.source,
    ]);
    const makeJob = (name: string) => ({
      id,
      source: f.source,
      target: f.target,
      method: 'run',
      args: { request: { prompt: `${name} secret prompt`, runId: id } },
    });
    expect((await f.call(f.alice.token, 'POST', 'jobs', makeJob('Alice'))).status).toBe(200);
    const offline = await f.call(f.bob.token, 'POST', 'jobs', makeJob('Bob'));
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('host_offline');
    for (const [method, path, body] of [
      ['GET', `jobs/${id}`, undefined],
      ['POST', `jobs/${id}/cancel`, undefined],
      ['PUT', `jobs/${id}`, { status: 'complete', events: [], result: 'forged' }],
    ] as const) {
      const result = await f.call(f.bob.token, method, path, body, f.target);
      expect(result.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain('Alice');
    }
    expect((await f.call(f.bob.token, 'GET', 'jobs', undefined, f.target)).body).toEqual([]);
    await f.heartbeat(f.bob.token);
    expect((await f.call(f.bob.token, 'POST', 'jobs', makeJob('Bob'))).status).toBe(200);
    for (const person of [f.alice, f.bob]) {
      const claimed = await f.call(person.token, 'GET', 'jobs', undefined, f.target);
      expect(claimed.body).toHaveLength(1);
      expect(claimed.body[0].args.request.prompt).toContain(person.workspace.name.split(' ')[0]);
    }
    await f.call(f.bob.token, 'POST', `jobs/${id}/cancel`);
    expect((await f.call(f.alice.token, 'GET', `jobs/${id}`)).body.cancel).toBe(false);
    await f.call(
      f.alice.token,
      'PUT',
      `jobs/${id}`,
      {
        status: 'complete',
        events: [{ kind: 'text', text: 'Alice private output' }],
        result: { private: 'Alice private result' },
      },
      f.target,
    );
    const bobResult = await f.call(f.bob.token, 'GET', `jobs/${id}`);
    expect(bobResult.body.cancel).toBe(true);
    expect(bobResult.body.status).toBe('running');
    expect(bobResult.body.events).toEqual([]);
    expect(JSON.stringify(bobResult.body)).not.toContain('Alice');
  });

  it.each(['folders', 'models', 'context', 'usage', 'title'] as const)(
    'isolates %s requests and private results from another workspace',
    async (method) => {
      const f = await fixture();
      await f.heartbeat(f.alice.token);
      const id = crypto.randomUUID();
      expect(
        (
          await f.call(f.alice.token, 'POST', 'jobs', {
            id,
            source: f.source,
            target: f.target,
            method,
            args: { path: '/home/alice/private', connectionId: f.source },
          })
        ).status,
      ).toBe(200);
      expect((await f.call(f.bob.token, 'GET', 'jobs', undefined, f.target)).body).toEqual([]);
      expect((await f.call(f.bob.token, 'GET', `jobs/${id}`)).status).toBe(404);
      await f.call(f.alice.token, 'GET', 'jobs', undefined, f.target);
      await f.call(
        f.alice.token,
        'PUT',
        `jobs/${id}`,
        {
          status: 'complete',
          events: [],
          result: { name: `Alice confidential ${method} metadata` },
        },
        f.target,
      );
      expect((await f.call(f.alice.token, 'GET', `jobs/${id}`)).body.result.name).toContain(
        'Alice',
      );
      expect((await f.call(f.bob.token, 'GET', `jobs/${id}`, undefined, f.target)).status).toBe(
        404,
      );
    },
  );

  it('binds browser cookies to their workspace, refuses stale tabs, and revokes replaced sessions', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    expect(alice.workspaceId).toBe(f.alice.workspace.id);
    expect(alice.workspaceName).toBe('Alice private');
    expect((await f.request('GET', 'state', undefined, alice.headers)).body.workspaceId).toBe(
      alice.workspaceId,
    );
    const missing = { ...alice.headers };
    delete missing['x-workspace-id'];
    expect((await f.request('GET', 'state', undefined, missing)).status).toBe(409);
    const bob = await f.pair(f.bob.token, f.source, alice.cookie);
    expect((await f.request('GET', 'state', undefined, alice.headers)).status).toBe(401);
    const stale = await f.request(
      'PUT',
      'state',
      {
        revision: 0,
        workspace: privateState('Alice', f.source, f.target),
      },
      { ...alice.headers, cookie: bob.cookie },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('workspace_changed');
    expect((await f.request('GET', 'state', undefined, bob.headers)).body.workspace).toEqual(
      emptyShared(),
    );
    expect((await f.request('GET', 'jobs', undefined, bob.headers)).status).toBe(403);
    expect(
      (
        await f.request(
          'POST',
          'heartbeat',
          {
            environmentId: f.source,
            connections: [],
            running: [crypto.randomUUID()],
          },
          bob.headers,
        )
      ).status,
    ).toBe(403);
    await f.restart();
    expect(
      (await f.request('GET', 'browser-session', undefined, { cookie: bob.cookie })).body
        .workspaceId,
    ).toBe(bob.workspaceId);
    expect((await f.request('GET', 'state', undefined, alice.headers)).status).toBe(401);
  });

  it('rejects cookie/bearer ambiguity without granting worker privileges or crossing a workspace', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    for (const key of [f.bob.token, 'invalid-key']) {
      for (const path of ['state', 'jobs']) {
        const result = await f.request('GET', path, undefined, {
          ...alice.headers,
          authorization: `Bearer ${key}`,
        });
        expect([401, 403, 409]).toContain(result.status);
        expect(JSON.stringify(result.body)).not.toContain('Bob');
      }
    }
  });

  it('rotates or disables one key immediately, revokes its cookies, and preserves other users across restart', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    const bob = await f.pair(f.bob.token);
    const rotated = rotateWorkspace({ directory: f.directory, id: f.alice.workspace.id });
    expect(rotated.token).not.toBe(f.alice.token);
    expect((await f.call(f.alice.token, 'GET', 'state')).status).toBe(401);
    expect((await f.request('GET', 'state', undefined, alice.headers)).status).toBe(401);
    expect((await f.call(rotated.token, 'GET', 'state')).body.workspaceId).toBe(
      f.alice.workspace.id,
    );
    expect((await f.request('GET', 'state', undefined, bob.headers)).status).toBe(200);
    const nextAlice = await f.pair(rotated.token);
    disableWorkspace({ directory: f.directory, id: f.alice.workspace.id });
    expect((await f.call(rotated.token, 'GET', 'state')).status).toBe(401);
    expect((await f.request('GET', 'state', undefined, nextAlice.headers)).status).toBe(401);
    await f.restart();
    expect((await f.call(rotated.token, 'GET', 'state')).status).toBe(401);
    expect((await f.request('GET', 'state', undefined, bob.headers)).status).toBe(200);
    expect((await f.call(f.token, 'GET', 'state')).status).toBe(200);
  });

  it.each(['bearer', 'cookie'] as const)(
    'rejects a delayed %s write whose access is revoked while its body is arriving',
    async (mode) => {
      const f = await fixture();
      const alice = await f.pair(f.alice.token);
      const headers =
        mode === 'bearer'
          ? { authorization: `Bearer ${f.alice.token}`, 'x-environment-id': f.source }
          : alice.headers;
      const pending = await f.stalledWrite(
        headers,
        privateState('Alice revoked request', f.source, f.target),
      );
      const rotated = rotateWorkspace({ directory: f.directory, id: f.alice.workspace.id });
      // Force creation of the new generation while the earlier handler is suspended.
      expect((await f.call(rotated.token, 'GET', 'state')).body.workspace).toEqual(emptyShared());
      pending.release();
      expect((await pending.completed).status).toBe(401);
      expect((await f.call(rotated.token, 'GET', 'state')).body.workspace).toEqual(emptyShared());
      await f.restart();
      expect((await f.call(rotated.token, 'GET', 'state')).body.workspace).toEqual(emptyShared());
    },
  );

  it('fails closed for a corrupt registry without overwriting its contents or falling back to the owner', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    const file = join(f.directory, 'workspaces.json');
    writeFileSync(file, '{broken-registry');
    for (const token of [f.token, f.alice.token, f.bob.token])
      expect((await f.call(token, 'GET', 'state')).status).toBe(503);
    expect((await f.request('GET', 'state', undefined, alice.headers)).status).toBe(503);
    expect(() => createWorkspace({ directory: f.directory, name: 'No replacement' })).toThrow(
      'preserved',
    );
    expect(readFileSync(file, 'utf8')).toBe('{broken-registry');
  });

  it('does not let an old push delivery overwrite new subscriptions after workspace key rotation', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    const makeSubscription = () => {
      const key = createECDH('prime256v1');
      key.generateKeys();
      return {
        endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      };
    };
    const before = makeSubscription();
    expect((await f.request('PUT', 'push', before, alice.headers)).status).toBe(200);
    const resume = f.pauseNextPush();
    expect((await f.request('POST', 'push/test', undefined, alice.headers)).status).toBe(202);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const rotated = rotateWorkspace({ directory: f.directory, id: f.alice.workspace.id });
    const nextAlice = await f.pair(rotated.token);
    const after = makeSubscription();
    expect((await f.request('PUT', 'push', after, nextAlice.headers)).status).toBe(200);
    resume();
    await vi.waitFor(() => expect(f.completedPushes).toBe(1));
    const onDisk = JSON.parse(
      readFileSync(join(f.directory, 'workspaces', f.alice.workspace.id, 'web-push.json'), 'utf8'),
    );
    expect(
      onDisk.subscribers.map(
        (subscriber: { subscription: { endpoint: string } }) => subscriber.subscription.endpoint,
      ),
    ).toEqual([after.endpoint]);
    await f.restart();
    expect((await f.request('GET', 'push', undefined, nextAlice.headers)).body.enabled).toBe(true);
    expect((await f.request('GET', 'push', undefined, alice.headers)).status).toBe(401);
  });

  it('routes lifecycle notifications and pending badges only to that workspace, including after key revocation', async () => {
    const f = await fixture();
    const alice = await f.pair(f.alice.token);
    const bob = await f.pair(f.bob.token);
    const subscriptions = [alice, bob].map(() => {
      const key = createECDH('prime256v1');
      key.generateKeys();
      return {
        endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      };
    });
    expect((await f.request('PUT', 'push', subscriptions[0], alice.headers)).status).toBe(200);
    expect((await f.request('PUT', 'push', subscriptions[1], bob.headers)).status).toBe(200);
    const running = privateState('Alice', f.source, f.target);
    expect(
      (await f.call(f.alice.token, 'PUT', 'state', { revision: 0, workspace: running })).status,
    ).toBe(200);
    const done = structuredClone(running);
    done.conversations[0].messages[0].status = 'complete';
    expect(
      (await f.call(f.alice.token, 'PUT', 'state', { revision: 1, workspace: done })).status,
    ).toBe(200);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0].endpoint).toBe(subscriptions[0].endpoint);
    expect(f.sent[0].payload.pendingCount).toBe(1);
    expect(JSON.stringify(f.sent)).not.toContain('Alice');
    expect((await f.request('POST', 'push/test', undefined, bob.headers)).status).toBe(202);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1].endpoint).toBe(subscriptions[1].endpoint);
    expect(f.sent[1].payload.pendingCount).toBe(0);
    const rotated = rotateWorkspace({ directory: f.directory, id: f.alice.workspace.id });
    expect((await f.request('POST', 'push/test', undefined, alice.headers)).status).toBe(401);
    const reconnected = await f.pair(rotated.token);
    expect((await f.request('GET', 'push', undefined, reconnected.headers)).body.enabled).toBe(
      false,
    );
    expect((await f.request('GET', 'push', undefined, bob.headers)).body.enabled).toBe(true);
  });
});
