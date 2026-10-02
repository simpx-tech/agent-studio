import { describe, expect, it } from 'vitest';
import {
  mergeScreenCards,
  screenCall,
  screenCardsSchema,
  screenDocument,
  screenFolderName,
  screenReply,
  screenRequestMs,
  screenRequestSchema,
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
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    for (const request of [
      { op: 'list', path: 'C:\\' },
      { op: 'read', id: '../workspace' },
      { op: 'read', id: id.toUpperCase() },
      { op: 'run', id, action: 'Remove-Item' },
      { op: 'run', id, action: 'list_prs', script: 'whoami' },
      { op: 'run', id, action: 'list_prs', params: { 'not a name': 1 } },
      { op: 'run', id, action: 'list_prs', params: { text: 'x'.repeat(64_001) } },
      { op: 'approve', id, digest: 'yes' },
      { op: 'save', id, key: '', value: 1 },
      { op: 'save', id, key: 'line\nbreak', value: 1 },
      { op: 'save', id, key: 'big', value: 'x'.repeat(1_000_000) },
      { op: 'exec', id },
    ])
      expect(screenRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    // A run waits for its action's longest limit; anything else answers within a minute.
    expect(screenRequestMs({ op: 'run' })).toBe(660_000);
    expect(screenRequestMs({ op: 'list' })).toBe(60_000);
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
      screenCall(message({ method: 'run', action: 'list_prs', params: { since: 'x' } }), token),
    ).toEqual({
      id: 1,
      method: 'run',
      action: 'list_prs',
      params: { since: 'x' },
    });
    expect(screenCall(message({ method: 'run', action: 'list_prs' }), token)?.method).toBe('run');
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
    expect(screenCall(message({ method: 'chat', text: 'Review #12' }), token)?.method).toBe('chat');
    for (const call of [
      message({ method: 'run', action: 'list_prs', token: 'other' }),
      { ...message({ method: 'run', action: 'list_prs' }), type: 'studio-artifact' },
      message({ method: 'run', action: 'list_prs', id: -1 }),
      message({ method: 'run', action: 'list_prs', id: 1.5 }),
      message({ method: 'run', action: 'Remove-Item' }),
      message({ method: 'run', action: 'list_prs', params: ['x'] }),
      message({ method: 'run', action: 'list_prs', params: { text: 'x'.repeat(64_001) } }),
      message({
        method: 'run',
        action: 'list_prs',
        params: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, i])),
      }),
      message({ method: 'load', key: '' }),
      message({ method: 'save', key: 'k'.repeat(101), value: 1 }),
      message({ method: 'save', key: 'big', value: 'x'.repeat(1_000_000) }),
      message({ method: 'chat', text: '   ' }),
      message({ method: 'chat', text: 'x'.repeat(8001) }),
      message({ method: 'exec', script: 'whoami' }),
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
    expect(screenReply(token, 4, { error: 'x'.repeat(5000) }).error).toHaveLength(4000);
  });

  it('starts every page with the bridge, the theme and data that cannot end its script', () => {
    const page = screenDocument(
      '<h1>Mine</h1>',
      'token</script><script>alert(1)</script>',
      {
        id,
        title: 'PRs </script><img src=x onerror=alert(1)>',
      },
      'light',
    );
    // The bridge's data stays inside its script element.
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).toContain('\\u003c/script\\u003e');
    expect(page).toContain("Object.defineProperty(window, 'studio'");
    expect(page).toContain('color-scheme:light');
    expect(page.indexOf('</head><body>')).toBeLessThan(page.indexOf('<h1>Mine</h1>'));
    // The page itself follows as given, fragment or whole document.
    expect(
      screenDocument('<!doctype html><html><body>Whole</body></html>', 't', { id, title: 't' }),
    ).toContain('<body><!doctype html><html><body>Whole</body></html></body>');
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

  it('are bounded and unique', () => {
    expect(screenCardsSchema.safeParse([card, card]).success).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...card,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
    }));
    expect(screenCardsSchema.safeParse(many).success).toBe(false);
    expect(mergeScreenCards(many.slice(0, 12), many.slice(12))).toHaveLength(12);
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
  });
});
