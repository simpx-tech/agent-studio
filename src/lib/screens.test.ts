import { describe, expect, it } from 'vitest';
import {
  jobDuration,
  mergeScreenCards,
  screenCall,
  screenCardsSchema,
  screenDetailSchema,
  screenDocument,
  screenFolderName,
  screenJobSchema,
  screenOutputSchema,
  screenReply,
  screenRequestSchema,
  screenSummarySchema,
  screenTheme,
  screenToolResultSchema,
  terminalText,
  type ScreenCard,
} from './screens';
import { applyRunEvent, retainRunEvent, savesAtOnce } from './activity';
import {
  historyFor,
  initialWorkspace,
  messageSchema,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { mergeShared, sharedWorkspace } from './sync';
import { toolVisual } from './tool-presentation';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentId = '11111111-1111-4111-8111-111111111111';
const card: ScreenCard = { id, revision: 1, title: 'My pull requests', environmentId };

describe('screen requests', () => {
  it('name a screen by its id alone and carry nothing the host would run as given', () => {
    for (const request of [
      { op: 'list' },
      { op: 'read', id },
      { op: 'run', id, action: 'list_prs', params: { since: '2026-09-28' } },
      { op: 'run', id, action: 'refresh' },
      { op: 'approve', id, digest: 'a'.repeat(64) },
      { op: 'revoke', id },
      { op: 'delete', id },
      { op: 'load', id },
      { op: 'save', id, key: 'filter', value: { state: 'open' } },
      { op: 'save', id, key: 'filter', value: null },
      // Action names, keys and values of any length.
      { op: 'run', id, action: 'list_prs', params: { text: 'x'.repeat(100_000) } },
      { op: 'run', id, action: `a${'b'.repeat(100)}` },
      { op: 'save', id, key: 'k'.repeat(200), value: 'x'.repeat(2_000_000) },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    for (const request of [
      { op: 'list', path: 'C:\\' },
      { op: 'read', id: '../workspace' },
      { op: 'read', id: id.toUpperCase() },
      { op: 'run', id, action: 'Remove-Item' },
      { op: 'run', id, action: 'list_prs', script: 'whoami' },
      { op: 'run', id, action: 'list_prs', params: { 'not a name': 1 } },
      { op: 'approve', id, digest: 'yes' },
      { op: 'save', id, key: '', value: 1 },
      { op: 'save', id, key: 'line\nbreak', value: 1 },
      { op: 'exec', id },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    // A value that cannot travel as JSON.
    expect(screenRequestSchema.safeParse({ op: 'save', id, key: 'big', value: 1n }).success).toBe(
      false,
    );
  });

  it('start actions and commands as jobs, and follow, stop and forget them by id', () => {
    for (const request of [
      { op: 'start', id, action: 'build', params: { config: 'Development' }, keep: true },
      { op: 'start', id, action: 'build' },
      {
        op: 'start',
        id,
        command: { shell: 'bash', script: 'gh pr list --json number', where: 'wsl' },
        params: { since: '2026-10-01' },
      },
      {
        op: 'start',
        id,
        command: { shell: 'powershell', script: 'x'.repeat(100_000), timeout: 9 },
      },
      { op: 'start', id, command: { shell: 'bash', script: 'ls', where: 'Ubuntu-24.04' } },
      { op: 'jobs', id },
      { op: 'output', id, job },
      { op: 'output', id, job, after: 4096, wait: true, peek: true },
      { op: 'stop', id, job },
      { op: 'forget', id, job },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    for (const request of [
      { op: 'start', id },
      { op: 'start', id, action: 'build', command: { shell: 'bash', script: 'ls' } },
      { op: 'start', id, command: { shell: 'cmd', script: 'dir' } },
      { op: 'start', id, command: { shell: 'bash', script: '  ' } },
      { op: 'start', id, command: { shell: 'bash', script: 'ls', where: 'C:\\' } },
      { op: 'start', id, command: { shell: 'bash', script: 'ls', timeout: 0 } },
      { op: 'start', id, command: { shell: 'bash', script: 'ls', cwd: '/' } },
      { op: 'output', id, job: '../x' },
      { op: 'output', id, job, after: -1 },
      { op: 'stop', id },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  it('call any MCP tool by its server and name, where and as whom the page names', () => {
    for (const request of [
      { op: 'mcp', id, server: 'linear', tool: 'list_issues' },
      { op: 'mcp', id, server: 'claude.ai Linear', tool: 'list_issues', arguments: { a: 1 } },
      { op: 'mcp', id, server: 'linear', tool: 'x', arguments: { text: 'x'.repeat(100_000) } },
      { op: 'mcp', id, server: 'linear', tool: 'x', where: 'wsl', account: 'Claude CLI login' },
      { op: 'tools', id },
      { op: 'tools', id, where: 'windows' },
      { op: 'ask', id, prompt: 'Summarize this', model: 'sonnet', system: 'Be brief.' },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    for (const request of [
      { op: 'mcp', id, server: '', tool: 'list_issues' },
      { op: 'mcp', id, server: 'linear', tool: ' list_issues' },
      { op: 'mcp', id, server: 'line\nar', tool: 'list_issues' },
      { op: 'mcp', id, server: 'linear', tool: 'list_issues', arguments: ['x'] },
      { op: 'mcp', id, server: 'linear', tool: 'list_issues', command: 'npx' },
      { op: 'mcp', id: '../x', server: 'linear', tool: 'list_issues' },
      { op: 'mcp', id, server: 'linear', tool: 'list_issues', arguments: { big: 1n } },
      { op: 'mcp', id, server: 'linear', tool: 'x', where: 'two words' },
      { op: 'mcp', id, server: 'linear', tool: 'x', account: 'a\nb' },
      { op: 'ask', id, prompt: '  ' },
      { op: 'ask', id, prompt: 'Hi', model: 'two words' },
    ])
      expect(
        screenRequestSchema.safeParse(request).success,
        JSON.stringify(request, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
      ).toBe(false);
  });

  it('read hosts from before MCP tools, jobs and places as screens without them', () => {
    const summary = {
      id,
      revision: 1,
      title: 'PRs',
      description: '',
      environmentId,
      project: '',
      folder: 'C:\\x',
      conversationId: environmentId,
      createdAt: '',
      updatedAt: '',
      commands: 1,
      allowed: false,
    };
    const older = screenDetailSchema.parse({
      ...summary,
      html: '<p></p>',
      actions: [],
      digest: 'a'.repeat(64),
    });
    expect(older.mcpTools).toEqual([]);
    expect(older.account).toBeUndefined();
    expect(screenSummarySchema.parse(summary).tools).toBeUndefined();
    expect(screenSummarySchema.parse(summary).running).toBeUndefined();
    const current = screenDetailSchema.parse({
      ...summary,
      allowed: true,
      running: 2,
      tools: 1,
      html: '<p></p>',
      actions: [{ name: 'build', shell: 'powershell', script: 'x', where: 'windows' }],
      mcpTools: [{ server: 'linear', tool: 'list_issues', where: 'wsl', account: 'Work' }],
      account: { provider: 'claude', connectionId: environmentId },
      digest: 'a'.repeat(64),
    });
    expect(current.mcpTools[0]).toMatchObject({ where: 'wsl', account: 'Work' });
    expect(current.actions[0].where).toBe('windows');
    expect(current.running).toBe(2);
    expect(
      screenToolResultSchema.parse({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
        account: 'Claude CLI login (Claude)',
      }),
    ).toMatchObject({ structuredContent: { ok: true }, account: 'Claude CLI login (Claude)' });
    // A job and its output as the host reports them.
    const record = {
      id: job,
      action: 'build',
      label: 'build',
      params: { config: 'Development' },
      keep: true,
      state: 'done',
      startedAt: '2026-10-30T12:00:00.000Z',
      endedAt: '2026-10-30T12:10:00.000Z',
      exitCode: 0,
      timedOut: false,
      durationMs: 600_000,
      bytes: 12,
    };
    expect(screenJobSchema.parse(record).state).toBe('done');
    expect(
      screenOutputSchema.parse({
        chunks: [
          { stream: 'stdout', text: 'built\n' },
          { stream: 'stderr', text: 'warned\n' },
        ],
        next: 12,
        job: record,
      }).chunks,
    ).toHaveLength(2);
    expect(jobDuration(screenJobSchema.parse(record), 0)).toBe('10m 0s');
    expect(
      jobDuration(
        { state: 'running', startedAt: '2026-10-30T12:00:00.000Z' },
        Date.parse('2026-10-30T13:05:09.000Z'),
      ),
    ).toBe('1h 5m');
  });
});

describe('the bridge of a screen page', () => {
  const token = 'frame-token';
  const message = (extra: Record<string, unknown>) => ({
    type: 'studio-screen',
    token,
    id: 1,
    ...extra,
  });
  it('accepts only its own frame’s well-formed calls', () => {
    expect(
      screenCall(message({ method: 'start', action: 'build', params: { config: 'x' } }), token),
    ).toEqual({ id: 1, method: 'start', action: 'build', params: { config: 'x' }, keep: false });
    expect(
      screenCall(
        message({
          method: 'start',
          command: { shell: 'bash', script: 'gh pr list', where: 'wsl' },
          keep: true,
        }),
        token,
      ),
    ).toEqual({
      id: 1,
      method: 'start',
      command: { shell: 'bash', script: 'gh pr list', where: 'wsl' },
      params: {},
      keep: true,
    });
    expect(screenCall(message({ method: 'jobs' }), token)).toEqual({ id: 1, method: 'jobs' });
    expect(screenCall(message({ method: 'output', job, after: 10, wait: true }), token)).toEqual({
      id: 1,
      method: 'output',
      job,
      after: 10,
      wait: true,
    });
    expect(screenCall(message({ method: 'stop', job }), token)).toEqual({
      id: 1,
      method: 'stop',
      job,
    });
    expect(screenCall(message({ method: 'forget', job }), token)?.method).toBe('forget');
    expect(screenCall(message({ method: 'load', key: 'filter' }), token)).toEqual({
      id: 1,
      method: 'load',
      key: 'filter',
    });
    // Undefined is saved as null, which removes the value.
    expect(screenCall(message({ method: 'save', key: 'filter' }), token)).toEqual({
      id: 1,
      method: 'save',
      key: 'filter',
      value: null,
    });
    expect(screenCall(message({ method: 'chat', text: 'Review #12' }), token)).toEqual({
      id: 1,
      method: 'chat',
      text: 'Review #12',
      send: false,
    });
    expect(screenCall(message({ method: 'chat', text: 'Go', send: true }), token)).toMatchObject({
      send: true,
    });
    expect(
      screenCall(
        message({
          method: 'mcp',
          server: 'linear',
          tool: 'list_issues',
          arguments: { a: 1 },
          where: 'wsl',
          account: ' Work ',
        }),
        token,
      ),
    ).toEqual({
      id: 1,
      method: 'mcp',
      server: 'linear',
      tool: 'list_issues',
      arguments: { a: 1 },
      where: 'wsl',
      account: 'Work',
    });
    // Without arguments the tool receives an empty object.
    expect(
      screenCall(message({ method: 'mcp', server: 'linear', tool: 'list_issues' }), token),
    ).toMatchObject({ arguments: {} });
    expect(screenCall(message({ method: 'servers', where: 'Ubuntu' }), token)).toEqual({
      id: 1,
      method: 'servers',
      where: 'Ubuntu',
    });
    expect(screenCall(message({ method: 'ask', prompt: 'Sum up', model: 'haiku' }), token)).toEqual(
      { id: 1, method: 'ask', prompt: 'Sum up', model: 'haiku', system: undefined },
    );
    expect(screenCall(message({ method: 'copy', text: '' }), token)).toEqual({
      id: 1,
      method: 'copy',
      text: '',
    });
    expect(
      screenCall(message({ method: 'open', url: 'https://linear.app/x/issue/A-1' }), token),
    ).toEqual({ id: 1, method: 'open', url: 'https://linear.app/x/issue/A-1' });
    // Values, keys and messages of any size, and any number of params.
    const params = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`p${i}`, 'x'.repeat(10_000)]),
    );
    expect(screenCall(message({ method: 'start', action: 'list_prs', params }), token)).toEqual({
      id: 1,
      method: 'start',
      action: 'list_prs',
      params,
      keep: false,
    });
    const value = 'x'.repeat(1_000_000);
    expect(screenCall(message({ method: 'save', key: 'k'.repeat(101), value }), token)).toEqual({
      id: 1,
      method: 'save',
      key: 'k'.repeat(101),
      value,
    });
    expect(screenCall(message({ method: 'chat', text: 'x'.repeat(8001) }), token)).toMatchObject({
      text: 'x'.repeat(8001),
    });
    for (const call of [
      message({ method: 'start', action: 'list_prs', token: 'other' }),
      { ...message({ method: 'start', action: 'list_prs' }), type: 'studio-artifact' },
      message({ method: 'start', action: 'list_prs', id: -1 }),
      message({ method: 'start', action: 'list_prs', id: 1.5 }),
      message({ method: 'start', action: 'Remove-Item' }),
      message({ method: 'start', action: 'list_prs', params: ['x'] }),
      message({ method: 'start', action: 'build', command: { shell: 'bash', script: 'ls' } }),
      message({ method: 'start', command: { shell: 'cmd', script: 'dir' } }),
      message({ method: 'start' }),
      message({ method: 'output', job: 'x' }),
      message({ method: 'output', job, after: -5 }),
      message({ method: 'stop' }),
      message({ method: 'load', key: '' }),
      message({ method: 'save', key: 'line\nbreak', value: 1 }),
      message({ method: 'chat', text: '   ' }),
      message({ method: 'mcp', server: '', tool: 'list_issues' }),
      message({ method: 'mcp', server: 'linear', tool: 'list\tissues' }),
      message({ method: 'mcp', server: 'linear', tool: 'list_issues', arguments: 'x' }),
      message({ method: 'mcp', server: 'linear', tool: 'list_issues', arguments: [] }),
      message({ method: 'mcp', server: 'linear', tool: 'x', where: 'C:\\' }),
      message({ method: 'servers', account: 'a\nb' }),
      message({ method: 'ask', prompt: ' ' }),
      message({ method: 'ask', prompt: 'x', model: 'two words' }),
      message({ method: 'copy', text: 4 }),
      message({ method: 'open', url: 'file:///C:/Windows/notepad.exe' }),
      message({ method: 'open', url: 'javascript:alert(1)' }),
      message({ method: 'run', action: 'list_prs' }),
      null,
      'studio-screen',
    ])
      expect(screenCall(call, token), JSON.stringify(call)?.slice(0, 120)).toBeUndefined();
    expect(screenReply(token, 4, { value: { exitCode: 0 } })).toEqual({
      type: 'studio-screen-reply',
      token,
      id: 4,
      ok: true,
      value: { exitCode: 0 },
    });
    // An error goes back whole.
    expect(screenReply(token, 4, { error: 'x'.repeat(5000) }).error).toBe('x'.repeat(5000));
    expect(screenTheme(token, 'light')).toEqual({
      type: 'studio-screen-theme',
      token,
      theme: 'light',
    });
  });

  it('starts every page with the bridge, the theme, its values and data that cannot end its script', () => {
    const page = screenDocument(
      '<h1>Mine</h1>',
      'token</script><script>alert(1)</script>',
      {
        id,
        title: 'PRs </script><img src=x onerror=alert(1)>',
      },
      'light',
      { filter: { state: 'open' }, note: '</script>' },
      'bash',
    );
    // The bridge's data stays inside its script element.
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).toContain('\\u003c/script\\u003e');
    expect(page).toContain("Object.defineProperty(window, 'studio'");
    for (const api of [
      "ask('start'",
      "ask('output'",
      "ask('stop'",
      "ask('forget'",
      "ask('jobs'",
      "ask('mcp'",
      "ask('servers'",
      "ask('ask'",
      "ask('copy'",
      "ask('open'",
      "ask('chat'",
      'async mcpJson(server, tool, args, options)',
      "addEventListener('abort'",
      "dispatchEvent(new CustomEvent('studio-theme'",
    ])
      expect(page, api).toContain(api);
    expect(page).toContain('"filter":{"state":"open"}');
    expect(page).toContain('const own = "bash"');
    expect(page).toContain('<style id="studio-theme">:root{color-scheme:light');
    expect(page.indexOf('</head><body>')).toBeLessThan(page.indexOf('<h1>Mine</h1>'));
    // The page itself follows as given, fragment or whole document.
    expect(
      screenDocument('<!doctype html><html><body>Whole</body></html>', 't', { id, title: 't' }),
    ).toContain('<body><!doctype html><html><body>Whole</body></html></body>');
  });

  it('shows what commands print as a terminal leaves it', () => {
    const escape = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(
      terminalText(
        `${escape}[31mred${escape}[0m plain\nprogress 10%\rprogress 100%\r\nnext ${escape}]0;title${bell}end`,
      ),
    ).toBe('red plain\nprogress 100%\nnext end');
    expect(terminalText('C:\\work> dir\r\n')).toBe('C:\\work> dir\n');
  });

  it('names where a screen runs as its folder or Standalone', () => {
    expect(
      screenFolderName({ project: 'C:\\Projects\\studio\\', folder: 'C:\\Projects\\studio' }),
    ).toBe('studio');
    expect(screenFolderName({ project: '/home/me/app', folder: '/home/me/app' })).toBe('app');
    expect(screenFolderName({ project: '', folder: 'C:\\AppData\\standalone\\x' })).toBe(
      'Standalone',
    );
  });
});

describe('a reply’s screen cards', () => {
  function reply(): Message {
    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      createdAt: new Date().toISOString(),
      status: 'complete',
      runId: crypto.randomUUID(),
      blocks: [{ type: 'markdown', text: 'I saved the screen.' }],
    };
  }

  it('keep each screen at its newest revision through events, storage and merges', () => {
    const message = reply();
    const events: RunEvent[] = [];
    for (const screen of [
      card,
      { ...card, id: id.replace('a', 'b') },
      { ...card, revision: 3, title: 'Renamed' },
      card,
    ]) {
      const event: RunEvent = { kind: 'screen', screen };
      applyRunEvent(message, event);
      retainRunEvent(events, event);
    }
    expect(savesAtOnce({ kind: 'screen' })).toBe(true);
    expect(message.screens?.map((s) => [s.title, s.revision])).toEqual([
      ['Renamed', 3],
      ['My pull requests', 1],
    ]);
    expect(events.map((e) => e.screen?.revision)).toEqual([3, 1]);
    // An invalid card never reaches the reply.
    applyRunEvent(message, { kind: 'screen', screen: { ...card, id: 'x' } });
    expect(message.screens).toHaveLength(2);
    expect(message.blocks).toHaveLength(1);
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Screens',
      settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      messages: [message],
    });
    expect(
      restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0].messages[0].screens,
    ).toEqual(message.screens);
    // Cards are never replayed into a provider's prompt.
    expect(historyFor(workspace.conversations[0])[0]).not.toHaveProperty('screens');
    const base = sharedWorkspace(workspace),
      local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations[0].messages[0].screens = [{ ...card, revision: 4 }];
    remote.conversations[0].messages[0].screens = [{ ...card, id: id.replace('a', 'c') }];
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations[0].messages[0].screens?.map((s) => s.revision)).toEqual([4, 1]);
  });

  it('are unique, however many a reply saves', () => {
    expect(screenCardsSchema.safeParse([card, card]).success).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...card,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
      title: 't'.repeat(200),
    }));
    expect(screenCardsSchema.safeParse(many).success).toBe(true);
    expect(mergeScreenCards(many.slice(0, 12), many.slice(12))).toEqual(many);
    expect(messageSchema.safeParse({ ...reply(), screens: [{ ...card, title: '' }] }).success).toBe(
      false,
    );
  });

  it('name their calls in Work history', () => {
    const tool = (name: string, detail?: string) =>
      toolVisual({
        id: 'claude:1',
        revision: 1,
        name,
        category: 'tool',
        status: 'complete',
        detail,
        facts: [],
        sources: [],
        agents: [],
      } as never);
    expect(tool('mcp__agent_studio__save_screen', 'My pull requests')).toMatchObject({
      icon: 'screen',
      title: 'Save screen',
      detail: 'My pull requests',
    });
    expect(tool('list_screens', 'Application tool call reported by Codex.')).toEqual({
      icon: 'screen',
      title: 'List screens',
      detail: undefined,
    });
    expect(tool('mcp__agent_studio__read_screen').title).toBe('Read screen');
    // A chat reaches another place's MCP servers as screens call them.
    expect(tool('mcp__agent_studio__call_mcp_tool', 'list_issues of linear in wsl')).toEqual({
      icon: 'plug',
      title: 'Call MCP tool',
      detail: 'list_issues of linear in wsl',
    });
    expect(tool('list_mcp_tools', 'Application tool call reported by Codex.')).toEqual({
      icon: 'plug',
      title: 'List MCP tools',
      detail: undefined,
    });
  });
});
