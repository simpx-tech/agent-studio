import { describe, expect, it } from 'vitest';
import type { Conversation } from './domain';
import { newDefinition, newNode, summarize, type WorkflowSummary } from './workflow-model';
import { testHost } from './workflow-test-host';
import { TriggerWatch, eventRunId } from './workflow-triggers';

const user = { kind: 'user' as const };

/** A saved workflow with one trigger of `kind` and the settings given, as its summary. */
function watched(kind: string, settings: Record<string, unknown> = {}): WorkflowSummary {
  const definition = newDefinition('Watcher', user);
  const trigger = newNode('start', { x: 0, y: 0 }, ['start']);
  trigger.config = { ...trigger.config, trigger: kind, [kind]: settings };
  definition.graph.nodes = [trigger];
  return summarize({
    id: crypto.randomUUID(),
    kind: 'definition',
    revision: 1,
    updatedAt: 'a',
    body: definition,
  });
}
function chat(t: ReturnType<typeof testHost>, title: string, path = 'C:\\game'): Conversation {
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title,
    settings: { provider: 'claude', model: 'opus', reasoning: 'max', instructions: '' },
    location: { computerId: t.computerId, environmentId: t.environmentId, path },
    createdAt: 'a',
    updatedAt: 'a',
    messages: [],
  };
  t.conversations.set(conversation.id, conversation);
  return conversation;
}
function reply(conversation: Conversation, status: 'running' | 'complete' | 'error', text = '') {
  const message = {
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    status,
    createdAt: 'a',
    blocks: text ? [{ type: 'markdown' as const, text }] : [],
    ...(status === 'error' ? { error: 'It broke.' } : {}),
  };
  conversation.messages.push(message);
  return message;
}

describe('trigger watch', () => {
  it('fires for a chat reply that ends after watching began, never for the past', () => {
    const t = testHost();
    const watch = new TriggerWatch();
    const summary = watched('chat', { events: ['completed', 'failed'], title: 'build' });
    const build = chat(t, 'Nightly build');
    const other = chat(t, 'Notes');
    reply(build, 'complete', 'Old reply');
    const running = reply(build, 'running');
    reply(other, 'running');
    expect(watch.observe(t.host, [summary], [], new Set())).toEqual([]);
    running.status = 'complete';
    running.blocks = [{ type: 'markdown', text: 'Built 3 targets.' }];
    t.conversations.get(other.id)!.messages.at(-1)!.status = 'complete';
    const fires = watch.observe(t.host, [summary], [], new Set());
    expect(fires).toEqual([
      expect.objectContaining({
        definitionId: summary.id,
        kind: 'chat',
        key: `chat:completed:${running.id}`,
        text: 'Built 3 targets.',
        payload: expect.objectContaining({
          event: 'completed',
          conversationId: build.id,
          reply: 'Built 3 targets.',
          folder: 'C:\\game',
        }),
      }),
    ]);
    // Seen once: the next look starts nothing.
    expect(watch.observe(t.host, [summary], [], new Set())).toEqual([]);
    // A failure, but not in a chat a workflow started.
    reply(build, 'error');
    const hidden = chat(t, 'Build step');
    reply(hidden, 'running');
    watch.observe(t.host, [summary], [], new Set([hidden.id]));
    hidden.messages.at(-1)!.status = 'error';
    const failed = watch.observe(t.host, [summary], [], new Set([hidden.id]));
    expect(failed).toEqual([]);
  });

  it('fires when a run ends, a computer changes state and an account has room again', () => {
    const t = testHost();
    const watch = new TriggerWatch();
    const runEnds = watched('workflow', { statuses: ['completed'] });
    const online = watched('computer', { event: 'offline' });
    const usage = watched('usage', { provider: 'claude' });
    const run = {
      ...summarize({
        id: crypto.randomUUID(),
        kind: 'run',
        revision: 1,
        updatedAt: 'a',
        body: {
          mode: 'static',
          title: 'Report',
          status: 'running',
          definition: { id: crypto.randomUUID() },
        },
      }),
    };
    t.usage.set(t.connections[0], {
      provider: 'claude',
      checkedAt: t.now() / 1000,
      windows: [
        {
          id: '5h',
          label: '5-hour',
          usedPercent: 100,
          resetsAt: (t.now() + 3_600_000) / 1000,
          windowMinutes: 300,
          model: null,
          bucket: 'claude',
        },
      ],
      context: null,
      detail: '',
    });
    const all = [runEnds, online, usage];
    expect(watch.observe(t.host, all, [run], new Set())).toEqual([]);
    run.status = 'completed';
    t.offline.add(t.environmentId);
    t.usage.delete(t.connections[0]);
    const fires = watch.observe(t.host, all, [run], new Set());
    expect(fires.map((f) => [f.kind, f.definitionId])).toEqual([
      ['workflow', runEnds.id],
      ['computer', online.id],
      ['usage', usage.id],
    ]);
    expect(fires[0].payload).toMatchObject({ runId: run.id, status: 'completed', title: 'Report' });
    expect(fires[1].payload).toMatchObject({ event: 'offline', computer: 'Desktop' });
    expect(fires[2].payload).toMatchObject({ connectionId: t.connections[0], account: 'Work' });
  });

  it('never wakes a workflow on its own runs unless it names itself', () => {
    const t = testHost();
    const watch = new TriggerWatch();
    const summary = watched('workflow', { statuses: ['completed'] });
    const own = summarize({
      id: crypto.randomUUID(),
      kind: 'run',
      revision: 1,
      updatedAt: 'a',
      body: { mode: 'static', title: 'Watcher', status: 'running', definition: { id: summary.id } },
    });
    watch.observe(t.host, [summary], [own], new Set());
    own.status = 'completed';
    expect(watch.observe(t.host, [summary], [own], new Set())).toEqual([]);
  });

  it('names the run an event starts the same way on every computer', async () => {
    const a = await eventRunId('w', 'n', 'chat:completed:m');
    expect(a).toBe(await eventRunId('w', 'n', 'chat:completed:m'));
    expect(a).not.toBe(await eventRunId('w', 'n', 'chat:completed:other'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
