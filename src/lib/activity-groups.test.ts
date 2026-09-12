import { describe, expect, it } from 'vitest';
import { activityGroupSummary, groupActivityEntries } from './activity-groups';
import type { ToolActivity } from './activity';

const tool = (id: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  id,
  name: 'Read',
  revision: 1,
  category: 'tool',
  status: 'complete',
  sources: [],
  agents: [],
  ...extra,
});
const entry = (value: ToolActivity) => ({
  type: 'activity' as const,
  text: value.name,
  tool: value,
});

describe('activity groups', () => {
  it('keeps comments as boundaries and group identities stable across tool revisions and appends', () => {
    const first = entry(tool('read1'));
    const comment = {
      type: 'activity' as const,
      text: 'Now I will check the changes.',
      progress: { id: 'comment', revision: 1 },
    };
    const after = entry(tool('run1', { name: 'Run command' }));
    const original = groupActivityEntries([first, comment, after]);
    const updated = groupActivityEntries([
      entry(tool('read1', { revision: 2 })),
      entry(tool('read2')),
      comment,
      after,
    ]);
    expect(updated.map((g) => g.key)).toEqual(original.map((g) => g.key));
    expect(
      updated.map((g) => (g.kind === 'tools' ? g.tools.map((t) => t.id) : g.entry.text)),
    ).toEqual([['read1', 'read2'], comment.text, ['run1']]);
    expect(first.tool.revision).toBe(1);
    const arbitraryId = groupActivityEntries([
      { type: 'activity', text: 'A legacy note' },
      { ...comment, progress: { id: '0', revision: 1 } },
    ]);
    expect(new Set(arbitraryId.map((g) => g.key)).size).toBe(2);
  });

  it('uses reported file operations before the command flag and distinguishes reading a skill from invoking one', () => {
    const read = tool('read', {
      category: 'skill',
      name: 'Read skill file',
      operation: 'read',
      commandRun: true,
    });
    expect(activityGroupSummary([read], 'complete').label).toBe('Read files');
    expect(
      activityGroupSummary(
        [tool('skill', { category: 'skill', name: 'Skill: review' })],
        'complete',
      ).label,
    ).toBe('Used skills');
    expect(
      activityGroupSummary(
        [
          tool('generic', {
            name: 'Unknown tool',
            detail: 'Edit files and run commands',
            path: '/fixture/app.ts',
          }),
        ],
        'complete',
      ).label,
    ).toBe('Used tools');
  });

  it('summarizes mixed operations without treating repeated calls as more action kinds', () => {
    const edits = [
      tool('edit1', { name: 'Edit', operation: 'edit' }),
      tool('edit2', { name: 'Write', operation: 'edit' }),
    ];
    const command = tool('run', { name: 'Bash', status: 'running' });
    expect(activityGroupSummary([...edits, command], 'running')).toMatchObject({
      label: 'Editing files and running commands',
      running: true,
      issue: undefined,
    });
    expect(
      activityGroupSummary([...edits, { ...command, status: 'complete' }], 'complete').label,
    ).toBe('Edited files and ran commands');
    expect(
      activityGroupSummary([...edits, { ...command, status: 'complete' }, tool('read')], 'complete')
        .label,
    ).toBe('Edited files, ran commands, and more');
  });

  it('keeps failures visible during other running work and avoids claiming an unconfirmed success', () => {
    const failed = tool('bad', { name: 'Edit', status: 'error' });
    const running = tool('run', { name: 'Run command', status: 'running' });
    expect(activityGroupSummary([failed, running], 'running')).toMatchObject({
      label: 'File edits and commands',
      running: true,
      issue: 'error',
    });
    expect(activityGroupSummary([running], 'complete')).toMatchObject({
      label: 'Commands',
      running: false,
      issue: 'unknown',
    });
    expect(activityGroupSummary([running], 'cancelled')).toMatchObject({
      label: 'Commands',
      running: false,
      issue: 'cancelled',
    });
  });

  it('surfaces incomplete child status in the collapsed sub-agent group', () => {
    const parent = tool('parent', {
      category: 'agent',
      name: 'Sub-agents',
      agents: [{ id: 'child', name: 'Reader', status: 'running' }],
    });
    expect(activityGroupSummary([parent], 'complete')).toMatchObject({
      label: 'Sub-agent work',
      issue: 'unknown',
      running: false,
    });
    parent.agents[0].status = 'complete';
    const child = tool('child-read', { parentId: 'child', status: 'error' });
    expect(activityGroupSummary([parent], 'complete', [parent, child])).toMatchObject({
      label: 'Sub-agent work',
      issue: 'error',
      running: false,
    });
  });
});
