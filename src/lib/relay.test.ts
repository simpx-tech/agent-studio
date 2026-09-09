import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import { emptyShared } from './sync';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  let time = Date.now();
  const token = 'synthetic-test-pairing-key-'.repeat(2);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-relay-'));
  const server = createRelay({ token, directory, now: () => time });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const source = crypto.randomUUID(),
    target = crypto.randomUUID();
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    actor = source,
    key = token,
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'x-environment-id': actor,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    call,
    source,
    target,
    directory,
    token,
    server,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe('real HTTP relay', () => {
  it('requires authentication, rejects stale writes, and persists acknowledged workspace data', async () => {
    const f = await fixture();
    expect((await f.call('GET', 'state', undefined, f.source, 'wrong')).status).toBe(401);
    const workspace = emptyShared();
    workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    expect((await f.call('PUT', 'state', { revision: 0, workspace })).status).toBe(200);
    expect((await f.call('PUT', 'state', { revision: 0, workspace: emptyShared() })).status).toBe(
      409,
    );
    const saved = JSON.parse(readFileSync(join(f.directory, 'workspace.json'), 'utf8'));
    expect(saved.revision).toBe(1);
    expect(saved.workspace.fleet.computers[0].name).toBe('Desktop');
    expect(JSON.stringify(saved)).not.toContain(f.token);
    const restarted = createRelay({ token: f.token, directory: f.directory });
    restarted.close();
  });
  it('routes work to the exact environment, claims once, streams progress, cancels and deduplicates submissions', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id,
      source: f.source,
      target: f.target,
      method: 'run',
      args: { request: { runId: id } },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('POST', 'jobs', job)).body.id).toBe(id);
    expect((await f.call('GET', 'jobs')).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toHaveLength(1);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toEqual([]);
    expect((await f.call('PUT', `jobs/${id}`, { status: 'running', events: [] })).status).toBe(404);
    await f.call(
      'PUT',
      `jobs/${id}`,
      { status: 'running', events: [{ kind: 'text', text: 'Hello' }] },
      f.target,
    );
    expect((await f.call('GET', `jobs/${id}`)).body.events[0].text).toBe('Hello');
    await f.call('POST', `jobs/${id}/cancel`);
    expect((await f.call('GET', `jobs/${id}`, undefined, f.target)).body.cancel).toBe(true);
    await f.call('PUT', `jobs/${id}`, { status: 'cancelled', events: [] }, f.target);
    expect((await f.call('POST', 'jobs', job)).body.status).toBe('cancelled');
  });
  it('expires presence and abandoned jobs without replaying them', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    await f.call('POST', 'jobs', {
      id,
      source: f.source,
      target: f.target,
      method: 'usage',
      args: {},
    });
    await f.call('GET', 'jobs', undefined, f.target);
    f.advance(46_000);
    const peers = await f.call('POST', 'heartbeat', {
      environmentId: f.source,
      connections: [],
      running: [],
    });
    expect(peers.body.find((p: any) => p.environmentId === f.target).online).toBe(false);
    expect((await f.call('GET', `jobs/${id}`)).body.status).toBe('error');
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toEqual([]);
    expect(
      (
        await f.call('POST', 'jobs', {
          id: crypto.randomUUID(),
          source: f.source,
          target: f.target,
          method: 'run',
          args: {},
        })
      ).status,
    ).toBe(409);
  });
  it('preserves corrupt disk state and rejects invalid payloads', async () => {
    const f = await fixture();
    expect((await f.call('PUT', 'state', { revision: 0, workspace: { fleet: null } })).status).toBe(
      400,
    );
    writeFileSync(join(f.directory, 'workspace.json'), '{invalid');
    expect(() => createRelay({ token: f.token, directory: f.directory })).toThrow('preserved');
    expect(readFileSync(join(f.directory, 'workspace.json'), 'utf8')).toBe('{invalid');
  });
});
