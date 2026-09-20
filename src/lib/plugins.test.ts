import { describe, it, expect } from 'vitest';
import { pluginActionSchema, pluginRequestSchema } from './plugins';
import { createContextCache, type ContextSnapshot } from './context';
import { retainRunEvent, applyRunEvent } from './activity';
import type { Message, RunEvent } from './domain';

describe('plugin management boundaries', () => {
  it('rejects arbitrary commands, credential URLs, relative paths, untrusted evaluations and excessive inputs', () => {
    for (const action of [
      { kind: 'install', id: '--all' },
      { kind: 'toggle', id: 'demo@local', enabled: true, command: 'arbitrary' },
      { kind: 'skill', path: '../SKILL.md', enabled: false },
      {
        kind: 'runtime',
        pluginDirs: [],
        pluginUrls: ['https://example.com/a.zip?token=secret'],
        skillRoots: [],
      },
      { kind: 'runtime', pluginDirs: [], pluginUrls: [], skillRoots: Array(9).fill('/skills') },
      {
        kind: 'eval',
        id: 'demo@local',
        operationId: crypto.randomUUID(),
        maxCostUsd: 1,
        trusted: false,
      },
    ])
      expect(pluginActionSchema.safeParse(action).success).toBe(false);
    expect(
      pluginRequestSchema.safeParse({
        provider: 'codex',
        connectionId: crypto.randomUUID(),
        action: { kind: 'list' },
        nativeSessionId: 'foreign',
      }).success,
    ).toBe(false);
  });
  it('invalidates in-flight inventory without letting old results replace a newer request', async () => {
    const pending: ((s: ContextSnapshot) => void)[] = [];
    const cache = createContextCache(() => new Promise((resolve) => pending.push(resolve)));
    const selected = { provider: 'codex' as const, model: '' };
    const old = cache.refresh(selected);
    await Promise.resolve();
    cache.clear();
    const current = cache.refresh(selected);
    await Promise.resolve();
    pending[0]({ checkedAt: 1 } as ContextSnapshot);
    await old;
    expect(cache.peek(selected)).toBeUndefined();
    expect(cache.refresh(selected)).toBe(current);
    pending[1]({ checkedAt: 2 } as ContextSnapshot);
    await current;
    expect(cache.peek(selected)?.checkedAt).toBe(2);
  });
  it('retains one revisioned invalidation signal without adding it to message history', () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 20; i++) retainRunEvent(events, { kind: 'skillschanged' });
    expect(events).toEqual([{ kind: 'skillschanged', revision: 20 }]);
    const message: Message = {
      id: 'reply',
      role: 'assistant',
      blocks: [{ type: 'markdown', text: 'Kept' }],
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    const before = JSON.stringify(message);
    applyRunEvent(message, events[0]);
    expect(JSON.stringify(message)).toBe(before);
  });
});
