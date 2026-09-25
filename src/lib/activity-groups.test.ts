import { describe, expect, it } from 'vitest';
import {
  activityEntries,
  activityGroupSummary,
  groupActivityEntries,
  groupIcon,
  liveAction,
  liveGroupItems,
  liveMemory,
  type LiveGroupItem,
} from './activity-groups';
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

  it('counts image reads as viewed images and picks the icon a group shares', () => {
    const shot = (id: string) =>
      tool(id, { name: 'View image', operation: 'viewImage', path: `/tmp/${id}.png` });
    expect(activityGroupSummary([shot('a'), shot('b')], 'complete').label).toBe('Viewed 2 images');
    const command = (id: string, text: string) =>
      tool(id, { name: 'Run command', commandRun: true, operation: 'command', command: text });
    expect(groupIcon([command('a', 'git status'), command('b', 'git diff')])).toBe('git');
    // Different commands share only the general command icon.
    expect(groupIcon([command('a', 'git status'), command('b', 'npm test')])).toBe('terminal');
    // Later kinds of action do not change the first kind's icon.
    expect(groupIcon([command('a', 'npm test'), shot('b')])).toBe('test');
    expect(groupIcon([shot('a'), shot('b')])).toBe('image');
    expect(groupIcon([tool('r', { path: '/a.ts' }), tool('s', { path: '/b.md' })])).toBe('file');
    expect(groupIcon([])).toBe('tool');
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

  it('keeps running calls and the latest call in rows while the rest fold into the summary', () => {
    const memory = liveMemory();
    const read = (id: string, status: ToolActivity['status'] = 'complete') =>
      tool(id, { operation: 'read', path: `/src/${id}.ts`, status });
    const shape = (items: LiveGroupItem[]) =>
      items.map((item) =>
        item.kind === 'summary'
          ? `${item.key} [${item.tools.map((t) => t.id)}]`
          : item.kind === 'call'
            ? item.key
            : `${item.key} +${item.count}`,
      );
    // A finished call stays in view until the next one starts.
    expect(shape(liveGroupItems('g', [read('a')], true, 'running', memory))).toEqual(['call:a']);
    // It then becomes the summary in place, keeping its item's identity.
    expect(
      shape(liveGroupItems('g', [read('a'), read('b', 'running')], true, 'running', memory)),
    ).toEqual(['call:a [a]', 'call:b']);
    // Parallel calls keep their rows while they run; finished ones fold except the latest.
    const parallel = [read('a'), read('b'), read('c', 'running'), read('d'), read('e', 'running')];
    expect(shape(liveGroupItems('g', parallel, true, 'running', memory))).toEqual([
      'call:a [a,b,d]',
      'call:c',
      'call:e',
    ]);
    // Moving on folds the latest call too, and a folded call never gets its row back.
    const done = parallel.map((t) => ({ ...t, status: 'complete' as const }));
    expect(shape(liveGroupItems('g', done, false, 'running', memory))).toEqual([
      'call:a [a,b,c,d,e]',
    ]);
    expect(shape(liveGroupItems('g', done, true, 'running', memory))).toEqual([
      'call:a [a,b,c,d,e]',
    ]);
    // A row the reader opened stays until they close it.
    const opened = new Set(['x']);
    const fresh = liveMemory();
    const calls = [read('x'), read('y', 'running')];
    expect(shape(liveGroupItems('h', calls, true, 'running', fresh, opened))).toEqual([
      'call:x',
      'call:y',
    ]);
    opened.delete('x');
    expect(shape(liveGroupItems('h', calls, true, 'running', fresh, opened))).toEqual([
      'call:x [x]',
      'call:y',
    ]);
  });

  it('gives a folded sub-agent record that runs again a row of its own', () => {
    const memory = liveMemory();
    const agents = (status: ToolActivity['status']) =>
      tool('agents', {
        category: 'agent',
        name: 'Sub-agents',
        status,
        revision: status === 'running' ? 2 : 1,
        agents: [{ id: 'a1', name: 'Reader', status }],
      });
    const next = tool('next', { name: 'Run command', commandRun: true });
    expect(
      liveGroupItems('g', [agents('complete'), next], true, 'running', memory).map((i) => i.key),
    ).toEqual(['call:agents', 'call:next']);
    // The record keeps its place in the summary and gets a row under another key.
    expect(
      liveGroupItems('g', [agents('running'), next], true, 'running', memory).map((i) => i.key),
    ).toEqual(['call:agents', 'again:agents', 'call:next']);
  });

  it('returns the same items while a group’s calls stay the same', () => {
    const memory = liveMemory();
    const calls = [tool('a'), tool('b', { status: 'running' })];
    const first = liveGroupItems('g', calls, true, 'running', memory);
    expect(liveGroupItems('g', [...calls], true, 'running', memory)).toBe(first);
    const finished = { ...calls[1], revision: 2, status: 'complete' as const };
    expect(liveGroupItems('g', [calls[0], finished], true, 'running', memory)).not.toBe(first);
    expect(liveGroupItems('g', [calls[0], finished], false, 'running', memory)).toEqual([
      { kind: 'summary', key: 'call:a', tools: [calls[0], finished] },
    ]);
  });

  it('limits rows to the latest running calls', () => {
    const calls = Array.from({ length: 9 }, (_, i) => tool(`r${i}`, { status: 'running' }));
    const items = liveGroupItems('g', calls, true, 'running', liveMemory(), new Set(), 6);
    expect(items[0]).toEqual({ kind: 'more', key: 'more:g', count: 3 });
    expect(items.slice(1).map((i) => i.key)).toEqual(
      ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'].map((id) => `call:${id}`),
    );
  });

  it('says what a call does, did, or was from its reported metadata', () => {
    const command = tool('run', {
      name: 'Run command',
      commandRun: true,
      operation: 'command',
      command: 'npm test -- --run\necho done',
      detail: 'Run the tests',
    });
    // The command's first line, marked when more lines follow.
    expect(liveAction(command, 'running')).toEqual({
      icon: 'test',
      verb: 'Running',
      target: 'npm test -- --run …',
      code: true,
      hint: 'npm test -- --run\necho done',
    });
    expect(liveAction(command, 'complete').verb).toBe('Ran');
    // An unfinished call is named without claiming it ran.
    expect(liveAction(command, 'error').verb).toBe('Command');
    const image = tool('shot', {
      name: 'View image',
      operation: 'viewImage',
      path: '/repo/screens/home.png',
    });
    expect(liveAction(image, 'running', { folder: '/repo' })).toMatchObject({
      icon: 'image',
      verb: 'Viewing',
      target: 'screens/home.png',
      code: true,
    });
    const read = tool('read', { operation: 'read', path: '/repo/src/app.ts' });
    expect(liveAction(read, 'running', { folder: '/repo' })).toMatchObject({
      icon: 'code',
      verb: 'Reading',
      target: 'src/app.ts',
    });
    expect(
      liveAction(tool('write', { name: 'Write', operation: 'edit', path: '/a.ts' }), 'complete')
        .verb,
    ).toBe('Wrote');
    expect(
      liveAction(
        tool('grep', { name: 'Search file contents', operation: 'grep', query: 'TODO' }),
        'running',
      ),
    ).toMatchObject({ verb: 'Searching for', target: 'TODO', code: true });
    expect(
      liveAction(
        tool('glob', { name: 'Find files', operation: 'glob', query: '**/*.ts' }),
        'running',
      ),
    ).toMatchObject({ verb: 'Finding files matching', target: '**/*.ts' });
    expect(
      liveAction(
        tool('web', { category: 'search', name: 'Web search', query: 'svelte' }),
        'running',
      ),
    ).toMatchObject({ verb: 'Searching the web for', target: 'svelte' });
    const agents = tool('agents', {
      category: 'agent',
      name: 'Sub-agents',
      status: 'running',
      agents: [
        { id: 'a', name: 'Reader', status: 'complete' },
        { id: 'b', name: 'Writer', status: 'running' },
      ],
    });
    expect(liveAction(agents, 'running')).toMatchObject({ verb: 'Working with', target: 'Writer' });
    expect(
      liveAction(tool('skill', { category: 'skill', name: 'Skill: review' }), 'complete'),
    ).toMatchObject({ verb: 'Used skill', target: 'review' });
    expect(
      liveAction(tool('hook', { category: 'hook', name: 'PreToolUse hook' }), 'running'),
    ).toMatchObject({ verb: 'Running', target: 'PreToolUse hook' });
    expect(liveAction(tool('mcp', { name: 'mcp__docs__search' }), 'running')).toMatchObject({
      verb: 'Using',
      target: 'search',
      hint: 'docs',
    });
    expect(liveAction(tool('plan', { name: 'TodoWrite' }), 'running')).toEqual({
      icon: 'plan',
      verb: 'Updating the plan',
    });
    expect(liveAction(tool('ask', { name: 'AskUserQuestion' }), 'running').verb).toBe(
      'Waiting for your answer',
    );
    const server = tool('dev', {
      name: 'Run command',
      commandRun: true,
      command: 'npm run dev',
      status: 'running',
      background: true,
    });
    expect(liveAction(server, 'background')).toMatchObject({
      verb: 'Started in the background',
      target: 'npm run dev',
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
