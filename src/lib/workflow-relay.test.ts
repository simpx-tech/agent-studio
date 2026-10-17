import { afterEach, describe, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { createRelay } from '../../relay/server.ts';
import { pushService } from '../../relay/push';
import { recentAlerts } from '../../relay/workflows';
import { emptyShared } from './sync';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function relay() {
  let time = Date.now();
  const token = 'synthetic-workflow-pairing-key-'.repeat(2);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-workflows-'));
  const server = createRelay({ token, directory, now: () => time });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const desktop = crypto.randomUUID();
  const call = async (method: string, path: string, body?: unknown, actor = desktop) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': actor,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });
  return { call, desktop, directory, advance: (ms: number) => (time += ms) };
}

describe('relay workflow store', () => {
  it('keeps definitions and runs, reports its revision and refuses stale writes', async () => {
    const r = await relay();
    const before = await r.call('GET', 'state/revision');
    expect(before.body.workflows).toBe(0);
    const id = crypto.randomUUID();
    const created = await r.call('PUT', `workflows/${id}`, {
      kind: 'run',
      expected: null,
      body: { mode: 'dynamic', title: 'Assets', status: 'running', agents: [] },
      events: [{ kind: 'started', text: 'Started' }],
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, doc: { revision: 1 }, seq: 1 });
    const stale = await r.call('PUT', `workflows/${id}`, {
      kind: 'run',
      expected: 0,
      body: { title: 'Stale' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.current.body.title).toBe('Assets');
    expect((await r.call('GET', 'state/revision')).body.workflows).toBe(1);
    const listed = await r.call('POST', 'workflows/list', {});
    expect(listed.body.docs).toEqual([
      expect.objectContaining({ id, title: 'Assets', mode: 'dynamic', status: 'running' }),
    ]);
    const read = await r.call('POST', 'workflows/read', { ids: [id], events: { [id]: 0 } });
    expect(read.body.events[id]).toEqual([
      expect.objectContaining({ seq: 1, kind: 'started', text: 'Started' }),
    ]);
    expect(readdirSync(join(r.directory, 'workflows')).sort()).toEqual([
      `doc-${id}.json`,
      `events-${id}-0.json`,
      'index.json',
    ]);
    expect((await r.call('POST', `workflows/${id}/delete`, { expected: 1 })).status).toBe(200);
    expect((await r.call('POST', 'workflows/list', { since: 1 })).body.removed).toEqual([id]);
  });

  it('lets a desktop lease a run in its own name only', async () => {
    const r = await relay();
    const id = crypto.randomUUID();
    const other = crypto.randomUUID();
    expect(
      (await r.call('POST', `workflows/${id}/lease`, { holder: other, ttlMs: 60_000 })).status,
    ).toBe(403);
    const lease = await r.call('POST', `workflows/${id}/lease`, {
      holder: r.desktop,
      ttlMs: 60_000,
    });
    expect(lease.body).toMatchObject({ granted: true, lease: { holder: r.desktop } });
    const taken = await r.call(
      'POST',
      `workflows/${id}/lease`,
      { holder: other, ttlMs: 60_000 },
      other,
    );
    expect(taken.body).toMatchObject({ granted: false, lease: { holder: r.desktop } });
    r.advance(60_001);
    const after = await r.call(
      'POST',
      `workflows/${id}/lease`,
      { holder: other, ttlMs: 60_000 },
      other,
    );
    expect(after.body.granted).toBe(true);
  });

  it('refuses malformed requests', async () => {
    const r = await relay();
    expect((await r.call('POST', 'workflows/list', { since: -1 })).status).toBe(400);
    expect((await r.call('PUT', 'workflows/not-an-id', { kind: 'run' })).status).toBe(404);
    expect(
      (
        await r.call('PUT', `workflows/${crypto.randomUUID()}`, {
          kind: 'other',
          expected: null,
          body: {},
        })
      ).status,
    ).toBe(400);
  });
});

describe('workflow alerts', () => {
  function service() {
    const directory = mkdtempSync(join(tmpdir(), 'studio-workflow-push-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    let time = Date.now();
    const send = vi.fn(
      async (
        _subscription: webpush.PushSubscription,
        _payload: string,
        _options: webpush.RequestOptions,
      ) => {},
    );
    const quiet = new Set<string>();
    const push = pushService({
      directory,
      token: 'synthetic-workflow-notification-key',
      now: () => time,
      sessionActive: () => true,
      send,
      quiet: (id) => quiet.has(id),
    });
    const key = createECDH('prime256v1');
    key.generateKeys();
    push.subscribe(
      'session',
      crypto.randomUUID(),
      {
        endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      },
      'https://studio.example.com',
    );
    return {
      push,
      send,
      quiet,
      settle: async () => {
        time += 20_001;
        await push.drain();
      },
    };
  }

  it('alerts each workflow alert once, opening the workflow', async () => {
    const f = service();
    const runId = crypto.randomUUID();
    const alerts = [{ id: 'a1', kind: 'question' as const, text: 'Which art style?' }];
    f.push.workflowAlerts(runId, 'Game assets', alerts);
    f.push.workflowAlerts(runId, 'Game assets', alerts);
    await f.settle();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(JSON.parse(f.send.mock.calls[0][1])).toMatchObject({
      kind: 'attention',
      workflowId: runId,
      title: 'Game assets',
      body: 'Question: Which art style?',
    });
  });

  it('keeps a workflow chat’s end quiet', async () => {
    const f = service();
    const value = emptyShared();
    const id = crypto.randomUUID();
    value.conversations.push({
      id,
      title: 'Worker',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          role: 'assistant',
          status: 'complete',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'markdown', text: 'Done' }],
        },
      ],
    });
    f.quiet.add(id);
    f.push.changed(emptyShared(), value);
    await f.settle();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('reads only alerts a run raised in the last ten minutes', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const body = {
      alerts: [
        { id: 'old', kind: 'notify', title: '', text: 'Old', at: '2026-10-16T11:40:00Z' },
        { id: 'new', kind: 'completed', title: '', text: 'Done', at: '2026-10-16T11:59:00Z' },
        { id: 'bad', kind: 'other', title: '', text: 'x', at: '2026-10-16T11:59:00Z' },
      ],
    };
    expect(recentAlerts(body, now).map((a) => a.id)).toEqual(['new']);
  });
});
