import { describe, expect, it } from 'vitest';
import { activityEntries, activityGroupSummary, groupActivityEntries } from './activity-groups';
import type { ToolActivity } from './activity';
import type { ContentBlock } from './domain';

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
      updated.map((g) =>
        g.kind === 'comment' ? g.entry.text : g.kind === 'tools' && g.tools.map((t) => t.id),
      ),
    ).toEqual([['read1', 'read2'], comment.text, ['run1']]);
    expect(first.tool.revision).toBe(1);
    const arbitraryId = groupActivityEntries([
      { type: 'activity', text: 'A legacy note' },
      { ...comment, progress: { id: '0', revision: 1 } },
    ]);
    expect(new Set(arbitraryId.map((g) => g.key)).size).toBe(2);
  });

  it('places reasoning between comments and tool groups in recorded order', () => {
    const think = (id: string, text: string): ContentBlock => ({
      type: 'reasoning',
      id,
      revision: 1,
      text,
      truncated: false,
    });
    const call = (value: ToolActivity): ContentBlock => ({
      type: 'activity',
      text: value.name,
      tool: { ...value, facts: [] },
    });
    const blocks: ContentBlock[] = [
      { type: 'activity', text: 'Starting the provider CLI', order: 0 },
      { type: 'activity', text: 'I will check the folder.', progress: { id: 'p1', revision: 1 } },
      call(tool('read1')),
      think('msg1:1', 'Leave the folder untouched.'),
      // Older Claude replies saved the snapshot of the same thinking block again.
      think('msg1:0', 'Leave the folder untouched.'),
      call(tool('run1', { name: 'Run command' })),
      call(tool('run2', { name: 'Run command' })),
      think('msg2:1', 'Leave the folder untouched.'),
      think('rs_codex', '**Checking tests**'),
      { type: 'activity', text: 'Done.', progress: { id: 'p2', revision: 1 } },
      { type: 'markdown', text: 'Done.' },
    ];
    const tools = blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : []));
    const groups = groupActivityEntries(activityEntries(blocks, tools, 'Done.'));
    expect(
      groups.map((g) =>
        g.kind === 'reasoning'
          ? `reasoning ${g.block.id}`
          : g.kind === 'tools'
            ? g.tools.map((t) => t.id).join(',')
            : g.entry.text,
      ),
    ).toEqual([
      'I will check the folder.',
      'read1',
      'reasoning msg1:1',
      'run1,run2',
      'reasoning msg2:1',
      'reasoning rs_codex',
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it('uses reported file operations before the command flag and distinguishes reading a skill from invoking one', () => {
    const read = tool('read', {
      category: 'skill',
      name: 'Read skill file',
      operation: 'read',
      commandRun: true,
    });
    expect(activityGroupSummary([read], 'complete').label).toBe('Read 1 file');
    expect(
      activityGroupSummary(
        [tool('skill', { category: 'skill', name: 'Skill: review' })],
        'complete',
      ).label,
    ).toBe('Used 1 skill');
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
    ).toBe('Used 1 tool');
  });

  it('counts every action kind in first-seen order', () => {
    const edits = [
      tool('edit1', { name: 'Edit', operation: 'edit' }),
      tool('edit2', { name: 'Write', operation: 'edit' }),
    ];
    const command = tool('run', { name: 'Bash', status: 'running' });
    expect(activityGroupSummary([...edits, command], 'running')).toMatchObject({
      label: 'Editing 2 files and running 1 command',
      running: true,
      issue: undefined,
    });
    expect(
      activityGroupSummary([...edits, { ...command, status: 'complete' }], 'complete').label,
    ).toBe('Edited 2 files and ran 1 command');
    expect(
      activityGroupSummary([...edits, { ...command, status: 'complete' }, tool('read')], 'complete')
        .label,
    ).toBe('Edited 2 files, ran 1 command, and read 1 file');
  });

  it('counts each file once however often it was read or edited', () => {
    const read = (id: string, path?: string, extra: Partial<ToolActivity> = {}) =>
      tool(id, { operation: 'read', path, ...extra });
    const edit = (id: string, path?: string, extra: Partial<ToolActivity> = {}) =>
      tool(id, { name: 'Edit', operation: 'edit', path, ...extra });
    const reads = [
      read('app', 'C:\\fixture\\app.ts'),
      read('app-again', 'c:/fixture/app.ts', { facts: [{ label: 'Start line', value: '200' }] }),
      read('menu', 'C:\\fixture\\menu.ts'),
      // Without a reported path, a read cannot be matched with another one.
      read('unnamed'),
    ];
    const codexPatch = tool('patch', {
      name: 'Edit files',
      operation: 'edit',
      facts: [{ label: 'Files', value: 'C:\\fixture\\app.ts\nC:\\fixture\\tests.ts' }],
    });
    const edits = [edit('edit1', 'C:\\fixture\\app.ts'), edit('edit2', 'C:\\fixture\\app.ts')];
    expect(activityGroupSummary([...reads, codexPatch, ...edits], 'complete').label).toBe(
      'Read 3 files and edited 2 files',
    );
    const skillRead = read('skill', '/fixture/.agents/skills/demo/SKILL.md', {
      category: 'skill',
      name: 'Read skill file',
      facts: [{ label: 'Also read', value: 'README.md' }],
    });
    expect(activityGroupSummary([skillRead], 'complete').label).toBe('Read 2 files');
    expect(
      activityGroupSummary(
        [edit('first', '/fixture/app.ts'), edit('again', '/fixture/app.ts', { status: 'running' })],
        'running',
      ).label,
    ).toBe('Editing 1 file');
  });

  it('counts every call for commands, searches, pages, images, hooks and tools', () => {
    const calls = [
      ...['one', 'two', 'three'].map((id) => tool(id, { name: 'Run command', commandRun: true })),
      tool('grep', { name: 'Search file contents', operation: 'grep', query: 'TODO' }),
      tool('list', { name: 'List files', operation: 'glob' }),
      ...['web1', 'web2'].map((id) => tool(id, { category: 'search', name: 'Web search' })),
      tool('page', { category: 'search', name: 'Open web page' }),
      tool('image', { name: 'View image' }),
      ...['mcp1', 'mcp2'].map((id) => tool(id, { name: 'Connected tool: lookup' })),
    ];
    expect(activityGroupSummary(calls, 'complete').label).toBe(
      'Ran 3 commands, ran 2 file searches, ran 2 web searches, opened 1 web page, viewed 1 image, and used 2 tools',
    );
    const hooks = [
      tool('hook', { category: 'hook', name: 'PreToolUse hook' }),
      tool('context', { category: 'hook', name: 'Hook context', operation: 'hookContext' }),
    ];
    expect(activityGroupSummary(hooks, 'complete').label).toBe(
      'Ran 1 hook and received context from 1 hook',
    );
  });

  it('counts sub-agents by identity, apart from messages and directory checks', () => {
    const agents = tool('agents', {
      category: 'agent',
      name: 'Sub-agents',
      agents: [
        { id: 'first-call', agentId: 'same-child', name: 'Reader', status: 'complete' },
        { id: 'resume-call', agentId: 'same-child', name: 'Reader continued', status: 'complete' },
        { id: 'writer', name: 'Writer', status: 'complete' },
      ],
    });
    const messages = ['m1', 'm2'].map((id) =>
      tool(id, { name: 'Message agent', operation: 'sendMessage' }),
    );
    const directory = tool('list', { name: 'List agents', operation: 'listAgents' });
    expect(activityGroupSummary([agents, ...messages, directory], 'complete')).toMatchObject({
      label: 'Worked with 2 sub-agents, sent 2 agent messages, and checked 1 agent list',
      icon: 'agent',
    });
    expect(activityGroupSummary(messages, 'complete').icon).toBe('message');
  });

  it('marks calls past the activity limit without counting the notice as a call', () => {
    const limit = tool('activity-limit', { name: 'Activity limit reached', status: 'unknown' });
    expect(
      activityGroupSummary([tool('run', { name: 'Run command' }), limit], 'complete'),
    ).toMatchObject({ label: '1 command and later calls not shown', issue: 'unknown' });
    expect(activityGroupSummary([limit], 'complete').label).toBe('Later calls not shown');
  });

  it('keeps failures visible during other running work and avoids claiming an unconfirmed success', () => {
    const failed = tool('bad', { name: 'Edit', status: 'error' });
    const running = tool('run', { name: 'Run command', status: 'running' });
    expect(activityGroupSummary([failed, running], 'running')).toMatchObject({
      label: 'Edits to 1 file and 1 command',
      running: true,
      issue: 'error',
    });
    expect(
      activityGroupSummary([tool('read', { status: 'error' }), tool('again')], 'complete').label,
    ).toBe('Reads of 2 files');
    expect(activityGroupSummary([running], 'complete')).toMatchObject({
      label: '1 command',
      running: false,
      issue: 'unknown',
    });
    expect(activityGroupSummary([running], 'cancelled')).toMatchObject({
      label: '1 command',
      running: false,
      issue: 'cancelled',
    });
  });

  it('reads background launches as started work that never spins the group', () => {
    const build = tool('build', {
      name: 'Run command',
      commandRun: true,
      status: 'running',
      background: true,
    });
    const edit = tool('edit', { name: 'Edit', operation: 'edit' });
    expect(activityGroupSummary([edit, build], 'running')).toMatchObject({
      label: 'Edited 1 file and started 1 background task',
      running: false,
      issue: undefined,
    });
    const tests = tool('tests', { name: 'Run command', commandRun: true, status: 'running' });
    expect(activityGroupSummary([build, tests], 'running')).toMatchObject({
      label: 'Started 1 background task and running 1 command',
      icon: 'background',
      running: true,
    });
    // Work left running for the user is not an issue; a stop leaves its outcome unknown.
    expect(activityGroupSummary([build], 'complete')).toMatchObject({
      label: 'Started 1 background task',
      issue: undefined,
    });
    expect(activityGroupSummary([build], 'cancelled')).toMatchObject({
      label: '1 background task',
      issue: 'unknown',
    });
    expect(activityGroupSummary([{ ...build, status: 'error' }], 'complete')).toMatchObject({
      label: '1 background task',
      issue: 'error',
    });
    const monitor = tool('watch', {
      name: 'Monitor',
      operation: 'monitor',
      status: 'complete',
      background: true,
    });
    expect(activityGroupSummary([build, monitor], 'complete').label).toBe(
      'Started 2 background tasks',
    );
    const agents = tool('agents', {
      category: 'agent',
      name: 'Sub-agents',
      status: 'running',
      agents: [{ id: 'reader', name: 'Reader', status: 'running', background: true }],
    });
    const childRead = tool('child-read', { parentId: 'reader', status: 'running' });
    expect(activityGroupSummary([agents], 'running', [agents, childRead])).toMatchObject({
      label: 'Started 1 background sub-agent',
      icon: 'backgroundAgent',
      running: false,
    });
    const mixed = {
      ...agents,
      agents: [...agents.agents, { id: 'writer', name: 'Writer', status: 'running' as const }],
    };
    expect(activityGroupSummary([mixed], 'running')).toMatchObject({
      label: 'Working with 2 sub-agents',
      running: true,
    });
  });

  it('surfaces incomplete child status in the collapsed sub-agent group', () => {
    const parent = tool('parent', {
      category: 'agent',
      name: 'Sub-agents',
      agents: [{ id: 'child', name: 'Reader', status: 'running' }],
    });
    expect(activityGroupSummary([parent], 'complete')).toMatchObject({
      label: '1 sub-agent',
      issue: 'unknown',
      running: false,
    });
    parent.agents[0].status = 'complete';
    const child = tool('child-read', { parentId: 'child', status: 'error' });
    expect(activityGroupSummary([parent], 'complete', [parent, child])).toMatchObject({
      label: '1 sub-agent',
      issue: 'error',
      running: false,
    });
  });
});
