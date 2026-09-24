import { describe, expect, it } from 'vitest';
import type { ToolActivity } from './activity';
import type { Message } from './domain';
import {
  backgroundWorkEventSchema,
  messageBackgroundWork,
  replyBackgroundWork,
  runningBackgroundWork,
} from './background-work';

const tool = (id: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  id,
  name: 'Run command',
  revision: 1,
  category: 'tool',
  status: 'running',
  sources: [],
  agents: [],
  ...extra,
});

describe('background work', () => {
  it('lists running background launches in order with reported labels only', () => {
    const runs = runningBackgroundWork([
      tool('foreground', { commandRun: true, detail: 'Run the tests' }),
      tool('build', {
        commandRun: true,
        background: true,
        detail: 'Build the image',
        elapsedMs: 793_000,
      }),
      tool('agents', {
        category: 'agent',
        name: 'Sub-agents',
        agents: [
          { id: 'reader', name: 'Reader', status: 'running', background: true },
          { id: 'writer', name: 'Writer', status: 'running' },
          { id: 'done', name: 'Done', status: 'complete', background: true },
        ],
      }),
      tool('watch', { name: 'Monitor', operation: 'monitor', background: true }),
      tool('unnamed', { commandRun: true, background: true }),
      tool('finished', { commandRun: true, background: true, status: 'complete' }),
      tool('failed', { commandRun: true, background: true, status: 'error' }),
    ]);
    expect(runs).toEqual([
      { id: 'build', kind: 'command', label: 'Build the image', elapsedMs: 793_000 },
      { id: 'reader', kind: 'agent', label: 'Reader' },
      { id: 'watch', kind: 'monitor', label: 'Monitor' },
      { id: 'unnamed', kind: 'command', label: 'Background command' },
    ]);
    expect(runningBackgroundWork([tool('plain')])).toEqual([]);
  });

  it('shows each reply the work it started, then what the host still runs for it', () => {
    const reply = {
      role: 'assistant',
      runId: 'run-2',
      status: 'running',
      blocks: [
        {
          type: 'activity',
          text: 'Run command',
          tool: tool('build', { background: true, detail: 'Build', elapsedMs: 4000 }),
        },
      ],
    } as unknown as Message;
    const own = replyBackgroundWork(reply);
    expect(own).toEqual([{ id: 'build', kind: 'command', label: 'Build', elapsedMs: 4000 }]);
    expect(replyBackgroundWork({ ...reply, status: 'complete' })).toEqual([]);
    expect(replyBackgroundWork(undefined)).toEqual([]);
    const host = {
      at: 1000,
      runs: [
        { id: 'build', runId: 'run-2', kind: 'command' as const, label: 'Build', elapsedMs: 3000 },
        { id: 'watch', runId: 'run-2', kind: 'monitor' as const, label: 'Watch', elapsedMs: 50 },
        { id: 'server', runId: 'run-1', kind: 'command' as const, label: 'Server', elapsedMs: 9 },
      ],
    };
    // The running reply reports its own call; the host adds its other work, never another reply's.
    expect(messageBackgroundWork(reply, host)).toEqual([
      own[0],
      { id: 'watch', kind: 'monitor', label: 'Watch', elapsedMs: 50, since: 1000 },
    ]);
    const earlier = { ...reply, runId: 'run-1', status: 'complete' } as Message;
    expect(messageBackgroundWork(earlier, host)).toEqual([
      { id: 'server', kind: 'command', label: 'Server', elapsedMs: 9, since: 1000 },
    ]);
    // Replies without work share one empty list, and user messages never have any.
    const idle = { ...earlier, runId: 'run-0' } as Message;
    expect(messageBackgroundWork(idle, host)).toBe(messageBackgroundWork(idle, undefined));
    expect(messageBackgroundWork({ ...earlier, role: 'user' } as Message, host)).toEqual([]);
  });

  it('accepts only bounded host lists and outcomes', () => {
    const snapshot = {
      kind: 'snapshot',
      conversationId: 'chat',
      runs: [{ id: 'claude:a', runId: 'run', kind: 'monitor', label: 'Watch', elapsedMs: 5 }],
    };
    expect(backgroundWorkEventSchema.safeParse(snapshot).success).toBe(true);
    for (const invalid of [
      { ...snapshot, runs: [{ ...snapshot.runs[0], kind: 'agent' }] },
      { ...snapshot, runs: [{ ...snapshot.runs[0], elapsedMs: -1 }] },
      { ...snapshot, conversationId: '' },
      { ...snapshot, runs: Array(33).fill(snapshot.runs[0]) },
      { kind: 'tool', conversationId: 'chat', runId: 'run', tool: { id: 'claude:a' } },
    ])
      expect(backgroundWorkEventSchema.safeParse(invalid).success).toBe(false);
    const outcome = backgroundWorkEventSchema.parse({
      kind: 'tool',
      conversationId: 'chat',
      runId: 'run',
      tool: { ...tool('claude:a', { status: 'complete', background: true }), stdout: 'PRIVATE' },
    });
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
  });
});
