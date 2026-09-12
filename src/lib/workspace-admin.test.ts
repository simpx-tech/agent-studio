import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import {
  createWorkspace,
  listWorkspaces,
  rotateWorkspace,
  disableWorkspace,
} from '../../relay/workspaces.ts';
import { emptyShared } from './sync';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-workspace-admin-'));
  const ownerKey = 'synthetic-admin-owner-private-key';
  const actor = crypto.randomUUID();
  let server = createRelay({ token: ownerKey, directory });
  server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const alice = createWorkspace({ directory, name: 'Alice private' });
  const bob = createWorkspace({ directory, name: 'Bob private' });
  async function request(
    method: string,
    path: string,
    value?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const call = (
    key: string,
    method = 'GET',
    path = 'workspace-admin',
    value?: unknown,
    extra: Record<string, string> = {},
  ) =>
    request(method, path, value, {
      authorization: `Bearer ${key}`,
      'x-environment-id': actor,
      ...extra,
    });
  async function pair(key: string) {
    const response = await request(
      'POST',
      'browser-session',
      { token: key, environmentId: actor },
      { origin: url },
    );
    expect(response.status).toBe(200);
    return {
      origin: url,
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      'x-environment-id': actor,
      'x-workspace-id': response.body.workspaceId,
    };
  }
  const edit = (key: string, id: string, name: string, role: 'admin' | 'member') =>
    call(key, 'PUT', `workspace-admin/workspaces/${id}`, { name, role });
  async function stalled(
    method: string,
    path: string,
    value: unknown,
    headers: Record<string, string>,
  ) {
    const received = new Promise<void>((resolve) => server.once('request', () => resolve()));
    let release!: () => void;
    const completed = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest(
        `${url}/v1/${path}`,
        {
          method,
          headers: { 'content-type': 'application/json', ...headers },
        },
        (response) => {
          let bytes = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            bytes += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode!, body: JSON.parse(bytes) }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      const serialized = JSON.stringify(value);
      request.write(serialized.slice(0, 1));
      release = () => request.end(serialized.slice(1));
    });
    await received;
    return { release, completed };
  }
  const restart = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createRelay({ token: ownerKey, directory });
    server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  };
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, actor, ownerKey, alice, bob, call, request, pair, edit, stalled, restart };
}

describe('workspace administration over real HTTP', () => {
  it('creates members first, rejects disabled transfer targets, and never disables the only admin', async () => {
    const f = await fixture();
    const before = readFileSync(join(f.directory, 'workspaces.json'), 'utf8');
    const refused = await f.call(f.ownerKey, 'POST', 'workspace-admin/workspaces', {
      name: 'Second admin',
      role: 'admin',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('create_member_first');
    expect(() =>
      createWorkspace({ directory: f.directory, name: 'CLI admin', role: 'admin' }),
    ).toThrow('Create a member');
    expect(readFileSync(join(f.directory, 'workspaces.json'), 'utf8')).toBe(before);
    disableWorkspace({ directory: f.directory, id: f.bob.workspace.id });
    const disabled = await f.edit(f.ownerKey, f.bob.workspace.id, 'Disabled admin', 'admin');
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe('workspace_disabled');
    expect(
      (await f.call(f.ownerKey)).body.workspaces.filter((entry: any) => entry.role === 'admin'),
    ).toHaveLength(1);
    expect((await f.edit(f.ownerKey, f.alice.workspace.id, 'Only admin', 'admin')).status).toBe(
      200,
    );
    expect(() => disableWorkspace({ directory: f.directory, id: f.alice.workspace.id })).toThrow(
      'exactly one',
    );
    const reenabled = rotateWorkspace({ directory: f.directory, id: f.bob.workspace.id });
    expect((await f.call(reenabled.token)).body.role).toBe('member');
    expect(
      (await f.call(f.alice.token)).body.workspaces.filter((entry: any) => entry.role === 'admin'),
    ).toHaveLength(1);
  });

  it.each([true, false])(
    'consolidates legacy multiple admins durably while preserving keys and sessions (owner admin: %s)',
    async (ownerAdmin) => {
      const f = await fixture();
      const aliceSession = await f.pair(f.alice.token);
      const file = join(f.directory, 'workspaces.json');
      const legacy = JSON.parse(readFileSync(file, 'utf8'));
      legacy.version = 1;
      legacy.owner.role = ownerAdmin ? 'admin' : 'member';
      for (const entry of legacy.workspaces) entry.role = 'admin';
      legacy.workspaces[0].createdAt = 1;
      legacy.workspaces[1].createdAt = 2;
      writeFileSync(file, JSON.stringify(legacy));
      await f.restart();
      const migrated = JSON.parse(readFileSync(file, 'utf8'));
      expect(migrated.version).toBe(2);
      const adminKey = ownerAdmin ? f.ownerKey : f.alice.token;
      const status = await f.call(adminKey);
      expect(
        status.body.workspaces
          .filter((entry: any) => entry.role === 'admin')
          .map((entry: any) => entry.id),
      ).toEqual([ownerAdmin ? 'owner' : f.alice.workspace.id]);
      for (let i = 0; i < legacy.workspaces.length; i++) {
        expect(migrated.workspaces[i].tokenHash).toBe(legacy.workspaces[i].tokenHash);
        expect(migrated.workspaces[i].sessionSecret).toBe(legacy.workspaces[i].sessionSecret);
      }
      expect((await f.request('GET', 'state', undefined, aliceSession)).status).toBe(200);
      expect((await f.call(f.bob.token)).body.role).toBe('member');
      await f.restart();
      expect((await f.call(adminKey)).body.role).toBe('admin');
    },
  );

  it('fails closed on a version2 registry containing multiple admins instead of granting extra authority', async () => {
    const f = await fixture();
    const file = join(f.directory, 'workspaces.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.workspaces[0].role = 'admin';
    const corrupted = JSON.stringify(stored);
    writeFileSync(file, corrupted);
    expect((await f.call(f.ownerKey)).status).toBe(503);
    expect((await f.call(f.alice.token)).status).toBe(503);
    expect(readFileSync(file, 'utf8')).toBe(corrupted);
  });

  it('migrates legacy roles to owner admin and members without disclosing their chats or setup', async () => {
    const f = await fixture();
    const file = join(f.directory, 'workspaces.json');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    legacy.version = 1;
    delete legacy.owner;
    for (const entry of legacy.workspaces) delete entry.role;
    writeFileSync(file, JSON.stringify(legacy));
    const aliceData = emptyShared();
    aliceData.fleet.computers.push({ id: f.actor, name: 'Alice confidential computer' });
    expect(
      (await f.call(f.alice.token, 'PUT', 'state', { revision: 0, workspace: aliceData })).status,
    ).toBe(200);
    const admin = await f.call(f.ownerKey);
    expect(admin.status).toBe(200);
    expect(admin.body.workspaceId).toBe('owner');
    expect(admin.body.role).toBe('admin');
    expect(admin.body.workspaces).toHaveLength(3);
    expect(
      admin.body.workspaces.find((entry: { id: string }) => entry.id === 'owner'),
    ).toMatchObject({ role: 'admin', enabled: true, createdAt: null });
    expect(
      admin.body.workspaces.find((entry: { id: string }) => entry.id === f.alice.workspace.id).role,
    ).toBe('member');
    expect(JSON.stringify(admin.body)).not.toContain('confidential computer');
    expect((await f.call(f.ownerKey, 'GET', 'state')).body.workspace).toEqual(emptyShared());
    const member = await f.call(f.alice.token);
    expect(member.status).toBe(200);
    expect(member.body).toEqual({ workspaceId: f.alice.workspace.id, role: 'member' });
    await f.restart();
    expect((await f.call(f.ownerKey)).body.role).toBe('admin');
    expect((await f.call(f.alice.token)).body.role).toBe('member');
  });

  it('lets an authenticated admin create, rename, and grant roles while keys appear only on creation and rotation', async () => {
    const f = await fixture();
    const owner = await f.pair(f.ownerKey);
    const created = await f.request(
      'POST',
      'workspace-admin/workspaces',
      { name: 'New person', role: 'member' },
      owner,
    );
    expect(created.status).toBe(201);
    expect(created.body.workspace).toMatchObject({
      name: 'New person',
      role: 'member',
      enabled: true,
    });
    expect(created.body.token.length).toBeGreaterThanOrEqual(32);
    expect((await f.call(created.body.token, 'GET', 'state')).body.workspace).toEqual(
      emptyShared(),
    );
    const updated = await f.edit(f.ownerKey, created.body.workspace.id, 'Renamed person', 'member');
    expect(updated.status).toBe(200);
    expect(updated.body.workspace).toMatchObject({ name: 'Renamed person', role: 'member' });
    expect(updated.body).not.toHaveProperty('token');
    expect((await f.call(created.body.token)).body.role).toBe('member');
    const rotated = await f.call(
      f.ownerKey,
      'POST',
      `workspace-admin/workspaces/${created.body.workspace.id}/rotate`,
      {},
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(created.body.token);
    expect((await f.call(created.body.token)).status).toBe(401);
    expect(
      (await f.edit(f.ownerKey, created.body.workspace.id, 'Renamed person', 'admin')).status,
    ).toBe(200);
    expect((await f.call(rotated.body.token)).body.role).toBe('admin');
    expect((await f.call(f.ownerKey)).body.role).toBe('member');
    for (const response of [
      await f.call(rotated.body.token),
      await f.call(rotated.body.token, 'GET', 'state'),
    ]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(created.body.token);
      expect(text).not.toContain(rotated.body.token);
      expect(text).not.toContain('sessionSecret');
      expect(text).not.toContain('tokenHash');
    }
    const registry = readFileSync(join(f.directory, 'workspaces.json'), 'utf8');
    expect(registry).not.toContain(created.body.token);
    expect(registry).not.toContain(rotated.body.token);
  });

  it('rejects member enumeration, mutations, forged headers, and roles injected through synced state', async () => {
    const f = await fixture();
    const forged = {
      ...emptyShared(),
      role: 'admin',
      owner: { role: 'admin' },
      workspaces: [{ id: f.alice.workspace.id, role: 'admin' }],
    };
    expect(
      (await f.call(f.alice.token, 'PUT', 'state', { revision: 0, workspace: forged })).status,
    ).toBe(200);
    const status = await f.call(f.alice.token, 'GET', 'workspace-admin', undefined, {
      'x-role': 'admin',
      'x-workspace-role': 'admin',
    });
    expect(status.body).toEqual({ workspaceId: f.alice.workspace.id, role: 'member' });
    for (const [method, suffix, value] of [
      ['GET', '/workspaces', undefined],
      ['POST', '/workspaces', { name: 'Unauthorized person', role: 'admin' }],
      ['PUT', `/workspaces/${f.alice.workspace.id}`, { name: 'Self promotion', role: 'admin' }],
      ['POST', `/workspaces/${f.bob.workspace.id}/rotate`, {}],
      ['POST', `/workspaces/${f.bob.workspace.id}/disable`, {}],
    ] as const) {
      const result = await f.call(f.alice.token, method, `workspace-admin${suffix}`, value);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('admin_required');
      expect(JSON.stringify(result.body)).not.toContain('Bob private');
    }
    expect(listWorkspaces(f.directory)).toHaveLength(2);
  });

  it('allows transferring admin authority and persists owner demotion while preventing loss of the final admin', async () => {
    const f = await fixture();
    const owner = await f.pair(f.ownerKey);
    const blocked = await f.edit(f.ownerKey, 'owner', 'Owner', 'member');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('final_admin');
    expect((await f.edit(f.ownerKey, f.alice.workspace.id, 'Alice admin', 'admin')).status).toBe(
      200,
    );
    expect((await f.edit(f.alice.token, 'owner', 'Former owner admin', 'member')).status).toBe(200);
    expect((await f.call(f.ownerKey)).body).toEqual({ workspaceId: 'owner', role: 'member' });
    expect(
      (
        await f.request(
          'POST',
          'workspace-admin/workspaces',
          { name: 'Denied', role: 'member' },
          owner,
        )
      ).status,
    ).toBe(403);
    expect((await f.call(f.ownerKey, 'GET', 'state')).status).toBe(200);
    const final = await f.edit(f.alice.token, f.alice.workspace.id, 'Alice admin', 'member');
    expect(final.status).toBe(409);
    expect(final.body.code).toBe('final_admin');
    await f.restart();
    expect((await f.call(f.ownerKey)).body.role).toBe('member');
    expect((await f.call(f.alice.token)).body.role).toBe('admin');
    expect((await f.edit(f.alice.token, 'owner', 'Owner restored', 'admin')).status).toBe(200);
  });

  it('serializes competing transfers so exactly one enabled admin remains and the former admin loses authority', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.edit(f.ownerKey, f.alice.workspace.id, 'Alice admin', 'admin'),
      f.edit(f.ownerKey, f.bob.workspace.id, 'Bob admin', 'admin'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    expect(results.find((result) => result.status === 403)?.body.code).toBe('admin_required');
    const roles = await Promise.all([
      f.call(f.ownerKey),
      f.call(f.alice.token),
      f.call(f.bob.token),
    ]);
    expect(roles.filter((result) => result.body.role === 'admin')).toHaveLength(1);
  });

  it('protects the owner and current workspace from rotation or disable and revokes another disabled workspace', async () => {
    const f = await fixture();
    expect((await f.edit(f.ownerKey, f.alice.workspace.id, 'Alice admin', 'admin')).status).toBe(
      200,
    );
    for (const action of ['rotate', 'disable']) {
      const owner = await f.call(
        f.alice.token,
        'POST',
        `workspace-admin/workspaces/owner/${action}`,
        {},
      );
      expect(owner.status).toBe(409);
      expect(owner.body.code).toBe('workspace_protected');
      const self = await f.call(
        f.alice.token,
        'POST',
        `workspace-admin/workspaces/${f.alice.workspace.id}/${action}`,
        {},
      );
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('self_workspace');
    }
    const bob = await f.pair(f.bob.token);
    const disabled = await f.call(
      f.alice.token,
      'POST',
      `workspace-admin/workspaces/${f.bob.workspace.id}/disable`,
      {},
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.workspace.enabled).toBe(false);
    expect(disabled.body).not.toHaveProperty('token');
    expect((await f.call(f.bob.token)).status).toBe(401);
    expect((await f.request('GET', 'workspace-admin', undefined, bob)).status).toBe(401);
    expect((await f.call(f.ownerKey)).status).toBe(200);
  });

  it.each(['bearer', 'cookie'] as const)(
    'rejects an admin %s request demoted while its body is still arriving',
    async (mode) => {
      const f = await fixture();
      expect((await f.edit(f.ownerKey, f.alice.workspace.id, 'Alice admin', 'admin')).status).toBe(
        200,
      );
      const headers =
        mode === 'cookie'
          ? await f.pair(f.alice.token)
          : { authorization: `Bearer ${f.alice.token}`, 'x-environment-id': f.actor };
      const pending = await f.stalled(
        'POST',
        'workspace-admin/workspaces',
        { name: 'Delayed unauthorized creation', role: 'admin' },
        headers,
      );
      expect((await f.edit(f.alice.token, 'owner', 'Owner', 'admin')).status).toBe(200);
      pending.release();
      const denied = await pending.completed;
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('admin_required');
      expect(listWorkspaces(f.directory)).toHaveLength(2);
    },
  );

  it('rejects a delayed admin mutation after its browser session is explicitly revoked', async () => {
    const f = await fixture();
    const owner = await f.pair(f.ownerKey);
    const pending = await f.stalled(
      'PUT',
      `workspace-admin/workspaces/${f.bob.workspace.id}`,
      { name: 'Should never rename', role: 'admin' },
      owner,
    );
    expect((await f.request('DELETE', 'browser-session', undefined, owner)).status).toBe(200);
    pending.release();
    expect((await pending.completed).status).toBe(401);
    expect(listWorkspaces(f.directory).find((entry) => entry.id === f.bob.workspace.id)?.name).toBe(
      'Bob private',
    );
  });

  it('rejects a delayed admin mutation after its workspace key is rotated', async () => {
    const f = await fixture();
    expect((await f.edit(f.ownerKey, f.alice.workspace.id, 'Alice admin', 'admin')).status).toBe(
      200,
    );
    const pending = await f.stalled(
      'POST',
      `workspace-admin/workspaces/${f.bob.workspace.id}/disable`,
      {},
      { authorization: `Bearer ${f.alice.token}`, 'x-environment-id': f.actor },
    );
    rotateWorkspace({ directory: f.directory, id: f.alice.workspace.id });
    pending.release();
    expect((await pending.completed).status).toBe(401);
    expect((await f.call(f.bob.token)).status).toBe(200);
  });

  it('denies cross-origin browser management, stale workspace headers, and mixed credentials', async () => {
    const f = await fixture();
    const owner = await f.pair(f.ownerKey);
    const crossOrigin = await f.request(
      'POST',
      'workspace-admin/workspaces',
      { name: 'Cross-site creation', role: 'admin' },
      { ...owner, origin: 'https://unrelated.example', 'sec-fetch-site': 'cross-site' },
    );
    expect([401, 403]).toContain(crossOrigin.status);
    expect(
      (
        await f.request('GET', 'workspace-admin', undefined, {
          ...owner,
          'x-workspace-id': f.alice.workspace.id,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(
          'POST',
          'workspace-admin/workspaces',
          { name: 'Conflicting credentials', role: 'admin' },
          { ...owner, authorization: `Bearer ${f.alice.token}` },
        )
      ).status,
    ).toBe(403);
    expect(listWorkspaces(f.directory)).toHaveLength(2);
  });

  it('preserves a corrupt registry and fails closed for admin reads and writes', async () => {
    const f = await fixture();
    const owner = await f.pair(f.ownerKey);
    const file = join(f.directory, 'workspaces.json');
    writeFileSync(file, '{invalid-admin-registry');
    expect((await f.call(f.ownerKey)).status).toBe(503);
    expect(
      (
        await f.request(
          'POST',
          'workspace-admin/workspaces',
          { name: 'No overwrite', role: 'admin' },
          owner,
        )
      ).status,
    ).toBe(503);
    expect(readFileSync(file, 'utf8')).toBe('{invalid-admin-registry');
  });

  it('rejects unknown fields, invalid roles, oversized names and bodies without changing the registry', async () => {
    const f = await fixture();
    const file = join(f.directory, 'workspaces.json');
    const before = readFileSync(file, 'utf8');
    for (const payload of [
      { name: 'Injected key', role: 'member', token: 'injected-key' },
      { name: 'Injected secret', role: 'admin', sessionSecret: 'injected-secret' },
      { name: 'Injected identity', role: 'member', workspaceId: 'owner' },
      { name: 'Bad role', role: 'owner' },
      { name: 'x'.repeat(81), role: 'member' },
      { name: 'x'.repeat(5000), role: 'admin' },
    ]) {
      for (const [method, path] of [
        ['POST', 'workspace-admin/workspaces'],
        ['PUT', `workspace-admin/workspaces/${f.alice.workspace.id}`],
      ]) {
        const response = await f.call(f.ownerKey, method, path, payload);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_admin_payload');
      }
    }
    for (const action of ['rotate', 'disable']) {
      const response = await f.call(
        f.ownerKey,
        'POST',
        `workspace-admin/workspaces/${f.alice.workspace.id}/${action}`,
        { workspaceId: 'owner' },
      );
      expect(response.status).toBe(400);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('preserves syntactically valid registry data with no enabled administrator and fails closed', async () => {
    const f = await fixture();
    const file = join(f.directory, 'workspaces.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.owner.role = 'member';
    data.workspaces[0].role = 'admin';
    data.workspaces[0].enabled = false;
    const invalid = JSON.stringify(data);
    writeFileSync(file, invalid);
    expect((await f.call(f.ownerKey)).status).toBe(503);
    expect((await f.call(f.bob.token)).status).toBe(503);
    expect(() => createWorkspace({ directory: f.directory, name: 'Unsafe recovery' })).toThrow(
      'preserved',
    );
    expect(readFileSync(file, 'utf8')).toBe(invalid);
  });

  it('the real CLI transfers roles, rejects the final administrator, and never prints stored secrets', async () => {
    const f = await fixture();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['relay/manage.ts', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_STUDIO_RELAY_DATA: f.directory },
        encoding: 'utf8',
      });
    const promote = run('role', f.alice.workspace.id, 'admin');
    expect(promote.status).toBe(0);
    expect(JSON.parse(promote.stdout)).toMatchObject({ id: f.alice.workspace.id, role: 'admin' });
    const demote = run('role', 'owner', 'member');
    expect(demote.status).toBe(0);
    expect(JSON.parse(demote.stdout)).toMatchObject({ id: 'owner', role: 'member' });
    const denied = run('role', f.alice.workspace.id, 'member');
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('exactly one enabled administrator');
    const list = run('list');
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(3);
    for (const result of [promote, demote, denied, list]) {
      const output = result.stdout + result.stderr;
      for (const secret of [f.ownerKey, f.alice.token, f.bob.token, 'tokenHash', 'sessionSecret'])
        expect(output).not.toContain(secret);
    }
    expect((await f.call(f.ownerKey)).body.role).toBe('member');
    expect((await f.call(f.alice.token)).body.role).toBe('admin');
  });
});
