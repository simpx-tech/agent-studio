import { describe, expect, it } from 'vitest';
import type { ToolActivity } from './activity';
import { runningBackgroundWork } from './background-work';

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
});
