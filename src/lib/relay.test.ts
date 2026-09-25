import { nativeWorkflowFixture } from '../../tests/native-workflow-fixture';
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
  it('routes Undo identities without accepting caller-supplied file content or paths', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'undoFiles',
      args: {
        conversationId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        commit: true,
      },
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...job.args, path: '/outside/file', content: 'replacement' },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(job.args);
  });
  it('routes explicit plan decisions to the owning host and retains proposed plans in checkpoints', async () => {
    const f = await fixture(),
      id = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
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
      args: { request: { runId: id, agent: { provider: 'claude', planMode: true } } },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect(
      (await f.call('GET', 'jobs', undefined, f.target)).body[0].args.request.agent.planMode,
    ).toBe(true);
    const question = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'approval',
          header: 'Plan mode',
          question: 'Approve?',
          options: [],
          multiSelect: false,
        },
      ],
      planApproval: { action: 'exit', text: 'A reviewable plan' },
    };
    const proposedPlan = {
      id: 'plan',
      revision: 2,
      text: 'Final proposed plan',
      complete: true,
      truncated: false,
    };
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${id}`,
          {
            status: 'running',
            events: [
              { kind: 'question', question },
              { kind: 'proposedplan', proposedPlan },
            ],
          },
          f.target,
        )
      ).status,
    ).toBe(200);
    const checkpoint = (await f.call('GET', `jobs/${id}`)).body;
    expect(checkpoint.events.find((e: any) => e.kind === 'question').question.planApproval).toEqual(
      question.planApproval,
    );
    expect(checkpoint.events.find((e: any) => e.kind === 'proposedplan').proposedPlan).toEqual(
      proposedPlan,
    );
    const decision = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'answer',
      args: {
        runId: id,
        connectionId,
        answer: {
          requestId: question.id,
          answers: [{ id: 'approval', values: ['Approve'] }],
          skipped: false,
        },
      },
    };
    expect((await f.call('POST', 'jobs', decision)).status).toBe(200);
    const owned = (await f.call('GET', 'jobs', undefined, f.target)).body;
    expect(owned.find((j: any) => j.id === decision.id).args).toEqual(decision.args);
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${decision.id}`,
          { status: 'complete', events: [], result: null },
          f.source,
        )
      ).status,
    ).toBe(404);
  });
  it('keeps active plugin evaluations beyond six minutes but bounds their lifetime and heartbeat', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'plugins',
      args: {
        provider: 'claude',
        connectionId: crypto.randomUUID(),
        action: {
          kind: 'eval',
          id: 'fixture@local',
          operationId: crypto.randomUUID(),
          trusted: true,
          maxCostUsd: 1,
        },
      },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    for (let second = 30; second <= 660; second += 30) {
      f.advance(30_000);
      const update = await f.call(
        'PUT',
        `jobs/${job.id}`,
        { status: 'running', events: [] },
        f.target,
      );
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('running');
    }
    f.advance(1);
    expect((await f.call('GET', `jobs/${job.id}`)).body.status).toBe('error');
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const abandoned = { ...job, id: crypto.randomUUID() };
    expect((await f.call('POST', 'jobs', abandoned)).status).toBe(200);
    f.advance(45_001);
    expect((await f.call('GET', `jobs/${abandoned.id}`)).body.status).toBe('error');
  });
  it('routes plugin management to its owner without persisting configuration in workspace state', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      action: { kind: 'skill', path: '/skills/private-fixture/SKILL.md', enabled: false },
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'plugins',
      args,
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...args, action: { kind: 'raw', method: 'config/write' } },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(args);
    expect(JSON.stringify((await f.call('GET', 'state')).body)).not.toContain('private-fixture');
  });
  it('routes MCP OAuth jobs transiently and rejects arbitrary native protocol payloads', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      action: { kind: 'authenticate', name: 'docs' },
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'mcp',
      args,
    };
    expect(
      (await f.call('POST', 'jobs', { ...job, args: { ...args, nativeSessionId: 'foreign' } }))
        .status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(args);
    const result = {
      status: 'pending',
      authorizationUrl: 'https://example.com/authorize?state=synthetic-private',
      operationId: crypto.randomUUID(),
      servers: [],
    };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'state')).body)).not.toContain('synthetic-private');
    f.advance(600_001);
    expect((await f.call('GET', `jobs/${job.id}`)).status).toBe(404);
  });
  it('routes bounded steering jobs only to their target host and rejects extra payload fields', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'steer',
      args: {
        runId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        input: { id: crypto.randomUUID(), text: 'Keep the current files' },
      },
    };
    expect(
      (await f.call('POST', 'jobs', { ...job, args: { ...job.args, threadId: 'caller-supplied' } }))
        .status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    const claimed = (await f.call('GET', 'jobs', undefined, f.target)).body;
    expect(claimed[0].args).toEqual(job.args);
    expect((await f.call('PUT', `jobs/${job.id}`, { status: 'complete' }, f.source)).status).toBe(
      404,
    );
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [] }, f.target)).status,
    ).toBe(200);
  });
  it('carries bounded reasoning alongside a full activity checkpoint', async () => {
    const f = await fixture(),
      id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    expect(
      (
        await f.call('POST', 'jobs', {
          id,
          source: f.source,
          target: f.target,
          method: 'run',
          args: { request: { runId: id, agent: { provider: 'codex' } } },
        })
      ).status,
    ).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const events = [
      ...Array.from({ length: 336 }, (_, i) => ({ kind: 'activity', text: `Activity ${i}` })),
      ...Array.from({ length: 64 }, (_, i) => ({
        kind: 'reasoning',
        id: `r${i}`,
        revision: 2,
        text: `Reasoning ${i}`,
        truncated: false,
      })),
    ];
    expect(
      (await f.call('PUT', `jobs/${id}`, { status: 'running', events }, f.target)).status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${id}`)).body.events).toEqual(events);
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${id}`,
          { status: 'running', events: Array(449).fill(events[0]) },
          f.target,
        )
      ).status,
    ).toBe(400);
  });
  it('routes bounded native instruction requests as transient jobs and rejects caller-supplied paths', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      conversationId: crypto.randomUUID(),
      provider: 'claude',
      connectionId: crypto.randomUUID(),
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'nativeInstructions',
      args,
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...args, path: '/another-profile/session.jsonl' },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const result = {
      provider: 'claude',
      checkedAt: Date.now(),
      notice: 'Recorded',
      studioGuidance: 'App guidance',
      blocks: [
        {
          label: 'System prompt',
          text: 'Synthetic native prompt',
          capturedAt: null,
          version: 'fixture',
          model: null,
        },
      ],
    };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'workspace')).body)).not.toContain(
      'Synthetic native prompt',
    );
    f.advance(600_001);
    expect((await f.call('GET', `jobs/${job.id}`)).status).toBe(404);
  });
  it('routes tool output reads as transient jobs that never reach the workspace', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      runId: crypto.randomUUID(),
      toolId: 'claude:toolu_01',
      connectionId: crypto.randomUUID(),
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'toolOutput',
      args,
    };
    for (const invalid of [
      { ...args, path: '/elsewhere/output.json' },
      { ...args, runId: '../run' },
      { ...args, toolId: '' },
      { ...args, toolId: 'a\nb' },
      { ...args, toolId: 'x'.repeat(241) },
      { ...args, full: 'yes' },
    ])
      expect((await f.call('POST', 'jobs', { ...job, args: invalid })).status).toBe(400);
    const image = { ...job, id: crypto.randomUUID(), method: 'toolOutputImage' };
    for (const invalid of [
      { ...args, index: -1 },
      { ...args, index: 1.5 },
      { ...args, index: 0, file: 'image-0.png' },
      args,
    ])
      expect((await f.call('POST', 'jobs', { ...image, args: invalid })).status).toBe(400);
    expect((await f.call('POST', 'jobs', { ...image, args: { ...args, index: 0 } })).status).toBe(
      200,
    );
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          id: crypto.randomUUID(),
          args: { ...args, full: true },
        })
      ).status,
    ).toBe(200);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const result = { version: 2, toolId: args.toolId, stdout: 'Synthetic tool output\n' };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'workspace')).body)).not.toContain(
      'Synthetic tool output',
    );
  });
  it('keeps healthy native workflows past one reply deadline while expiring abandoned work', async () => {
    const f = await fixture(),
      id = crypto.randomUUID();
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
      method: 'run',
      args: { request: { runId: id, agent: { provider: 'claude' } } },
    });
    await f.call('GET', 'jobs', undefined, f.target);
    for (let i = 0; i < 13; i++) {
      f.advance(30_000);
      const updated = await f.call(
        'PUT',
        `jobs/${id}`,
        {
          status: 'running',
          events: [
            {
              kind: 'nativeworkflow',
              nativeWorkflows: { ...nativeWorkflowFixture(), revision: i },
            },
          ],
        },
        f.target,
      );
      expect(updated.body.status).toBe('running');
    }
    expect(
      (await f.call('GET', `jobs/${id}`)).body.events[0].nativeWorkflows.runs[0].agents[0].status,
    ).toBe('complete');
    f.advance(46_000);
    expect((await f.call('GET', `jobs/${id}`)).body.status).toBe('error');
  });
  it('retains an empty relay identity across restart before the first workspace write', async () => {
    const f = await fixture();
    const before = (await f.call('GET', 'state')).body;
    expect(before.revision).toBe(0);
    expect(before.workspace).toEqual(emptyShared());
    const restarted = createRelay({ token: f.token, directory: f.directory });
    await new Promise<void>((resolve) => restarted.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(restarted.address() as { port: number }).port}/v1/state`,
        {
          headers: { authorization: `Bearer ${f.token}`, 'x-environment-id': f.source },
        },
      );
      expect(await response.json()).toEqual(before);
    } finally {
      restarted.closeAllConnections();
      await new Promise<void>((resolve) => restarted.close(() => resolve()));
    }
  });
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
  it('reports the state revision to pollers without the workspace', async () => {
    const f = await fixture();
    expect((await f.call('GET', 'state/revision', undefined, f.source, 'wrong')).status).toBe(401);
    const { instanceId } = (await f.call('GET', 'state')).body;
    expect((await f.call('GET', 'state/revision')).body).toEqual({ instanceId, revision: 0 });
    const workspace = emptyShared();
    workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    expect((await f.call('PUT', 'state', { revision: 0, workspace })).status).toBe(200);
    expect((await f.call('GET', 'state/revision')).body).toEqual({ instanceId, revision: 1 });
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
    const offline = await f.call('POST', 'jobs', {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'run',
      args: {},
    });
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('host_offline');
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
