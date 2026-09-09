import { describe, it, expect } from 'vitest';
import {
  applyRunEvent,
  retainRunEvent,
  visibleActivityStatus,
  safeSourceUrl,
  activityCounts,
  type ToolActivity,
} from './activity';
import {
  initialWorkspace,
  settingsFor,
  restoreWorkspace,
  historyFor,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, mergeShared } from './sync';

const tool = (
  id = 'search1',
  revision = 1,
  status: ToolActivity['status'] = 'running',
): ToolActivity => ({
  id,
  revision,
  status,
  category: 'search',
  name: 'Web search',
  query: 'Same query',
  sources: [],
  agents: [],
});
const message = (): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: '',
  blocks: [],
});

describe('structured tool activity', () => {
  it('keeps progress revisions in sequence, restores them, and excludes them from final history', () => {
    const m = message();
    const events: RunEvent[] = [];
    const stream: RunEvent[] = [
      { kind: 'progress', id: 'before', revision: 1, text: 'Inspecting the file.' },
      {
        kind: 'tool',
        tool: {
          ...tool('read'),
          category: 'tool',
          name: 'Read',
          path: '/fixture/readme.md',
          facts: [{ label: 'Lines read', value: '12' }],
        },
      },
      { kind: 'progress', id: 'after', revision: 1, text: 'Checked.' },
      { kind: 'progress', id: 'after', revision: 3, text: 'Checked the file.' },
      { kind: 'progress', id: 'after', revision: 2, text: 'Stale' },
      { kind: 'text', text: 'Final answer.' },
      { kind: 'usage', input: 1234, output: 20, costUsd: 0.012345 },
    ];
    for (const event of stream) {
      applyRunEvent(m, event);
      retainRunEvent(events, event);
    }
    const replay = message();
    for (const event of events) applyRunEvent(replay, event);
    expect(replay.blocks).toEqual(m.blocks);
    expect(replay.usage).toEqual(m.usage);
    expect(m.blocks.map((b) => b.text)).toEqual([
      'Inspecting the file.',
      'Read',
      'Checked the file.',
      'Final answer.',
    ]);
    m.status = 'complete';
    const w = initialWorkspace();
    w.conversations.push({
      id: crypto.randomUUID(),
      settings: settingsFor(w.preferences),
      title: 'Fixture',
      createdAt: '',
      updatedAt: '',
      messages: [m],
    });
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(w)));
    expect(restored.conversations[0].messages[0].blocks).toEqual(m.blocks);
    expect(restored.conversations[0].messages[0].usage?.costUsd).toBe(0.012345);
    expect(historyFor(restored.conversations[0])).toEqual([
      { role: 'assistant', text: 'Final answer.' },
    ]);
  });
  it('counts unique operations and children, with searches and command runs as subsets', () => {
    const run = {
      ...tool('run'),
      category: 'skill' as const,
      name: 'Read skill file',
      commandRun: true,
    };
    const group = {
      ...tool('agents'),
      category: 'agent' as const,
      agents: [{ id: 'child', name: 'Reader', status: 'complete' as const }],
    };
    expect(
      activityCounts([
        tool(),
        tool('search2'),
        run,
        run,
        group,
        group,
        { ...tool('open'), name: 'Open web page' },
      ]),
    ).toEqual({ calls: 4, searches: 2, runs: 1, agents: 1, limited: false });
    expect(
      activityCounts([
        {
          ...group,
          agents: [
            { id: 'first-call', agentId: 'same-child', name: 'Reader', status: 'complete' },
            {
              id: 'resume-call',
              agentId: 'same-child',
              name: 'Reader continued',
              status: 'complete',
            },
          ],
        },
      ]).agents,
    ).toBe(1);
  });
  it('keeps identical searches distinct, updates by identity, and ignores stale replay', () => {
    const m = message();
    for (const t of [tool(), tool('search2'), tool('search1', 3, 'complete'), tool('search1', 2)])
      applyRunEvent(m, { kind: 'tool', tool: t });
    expect(m.blocks).toHaveLength(2);
    expect(m.blocks[0].type === 'activity' && m.blocks[0].tool?.status).toBe('complete');
    expect(m.blocks[1].type === 'activity' && m.blocks[1].tool?.status).toBe('running');
  });
  it('keeps tool metadata through restore while excluding it from prompt history', () => {
    const w = initialWorkspace();
    const m = message();
    applyRunEvent(m, { kind: 'tool', tool: tool() });
    applyRunEvent(m, { kind: 'text', text: 'Actual answer' });
    m.status = 'complete';
    w.conversations.push({
      id: crypto.randomUUID(),
      settings: settingsFor(w.preferences),
      title: 'Fixture',
      createdAt: '',
      updatedAt: '',
      messages: [m],
    });
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(w)));
    expect(restored.conversations[0].messages[0].blocks).toEqual(m.blocks);
    expect(historyFor(restored.conversations[0])).toEqual([
      { role: 'assistant', text: 'Actual answer' },
    ]);
    expect(visibleActivityStatus('running', 'complete')).toBe('unknown');
    expect(visibleActivityStatus('running', 'cancelled')).toBe('cancelled');
    expect(visibleActivityStatus('complete', 'error')).toBe('complete');
  });
  it('merges progress independently of unchanged answer text without conflict copies', () => {
    const base = emptyShared();
    const w = initialWorkspace();
    const m = message();
    applyRunEvent(m, { kind: 'text', text: 'Same answer' });
    base.conversations.push({
      id: crypto.randomUUID(),
      settings: settingsFor(w.preferences),
      title: 'Fixture',
      createdAt: '',
      updatedAt: '',
      messages: [m],
    });
    const a = structuredClone(base),
      b = structuredClone(base);
    applyRunEvent(a.conversations[0].messages[0], { kind: 'tool', tool: tool() });
    applyRunEvent(b.conversations[0].messages[0], {
      kind: 'tool',
      tool: tool('search1', 4, 'complete'),
    });
    applyRunEvent(a.conversations[0].messages[0], { kind: 'tool', tool: tool('search2') });
    for (const merged of [mergeShared(base, a, b), mergeShared(base, b, a)]) {
      expect(merged.conversations).toHaveLength(1);
      const tools = merged.conversations[0].messages[0].blocks.flatMap((b) =>
        b.type === 'activity' && b.tool ? [b.tool] : [],
      );
      expect(tools).toHaveLength(2);
      expect(tools.find((t) => t.id === 'search1')?.status).toBe('complete');
    }
  });
  it('retains every bounded operation over relay plus its newest terminal state', () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 200; i++) retainRunEvent(events, { kind: 'tool', tool: tool(String(i)) });
    retainRunEvent(events, { kind: 'text', text: 'Answer' });
    retainRunEvent(events, { kind: 'tool', tool: tool('0', 2, 'error') });
    retainRunEvent(events, { kind: 'tool', tool: tool('0', 1) });
    expect(events).toHaveLength(201);
    expect(events[0].tool?.status).toBe('error');
    expect(events.at(-1)?.text).toBe('Answer');
  });
  it('rejects malformed activity and unsafe source links', () => {
    const m = message();
    applyRunEvent(m, {
      kind: 'tool',
      tool: { ...tool(), category: 'unknown' } as unknown as ToolActivity,
    });
    expect(m.blocks).toEqual([]);
    for (const url of [
      'javascript:alert(1)',
      'file:///private',
      'https://user:secret@example.com',
      'invalid',
    ])
      expect(safeSourceUrl(url)).toBeUndefined();
    expect(safeSourceUrl('https://example.com')).toBe('https://example.com/');
  });
});
