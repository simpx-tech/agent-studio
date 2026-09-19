import { describe, it, expect } from 'vitest';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';
import { compactionLabel } from './compaction';
import { contextFor } from './usage';
import { fallbackModels } from './models';

const event = (revision = 1, status: 'running' | 'complete' = 'running'): RunEvent => ({
  kind: 'compaction',
  compaction: {
    id: 'c1',
    revision,
    status,
    trigger: 'auto',
    preTokens: 90000,
    postTokens: 4000,
    usageRevision: 1,
  },
});
const reply = (): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: '',
  blocks: [],
  usage: { revision: 1, contextInput: 90000 },
});
describe('compaction history', () => {
  it('retains revisioned markers through checkpoints, save, export and stale sync without prompt content', () => {
    const message = reply(),
      events: RunEvent[] = [];
    for (const e of [event(), event(2, 'complete'), event()]) {
      applyRunEvent(message, e);
      retainRunEvent(events, e);
    }
    expect(message.compactions).toHaveLength(1);
    expect(message.compactions![0].status).toBe('complete');
    expect(message.usage?.contextInput).toBeNull();
    const replay = reply();
    events.forEach((e) => applyRunEvent(replay, e));
    expect(replay.compactions).toEqual(message.compactions);
    message.status = 'complete';
    message.blocks.push({ type: 'markdown', text: 'Answer' });
    const w = initialWorkspace(),
      settings = settingsFor(w.preferences);
    message.settings = settings;
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Test',
      createdAt: '',
      updatedAt: '',
      settings,
      messages: [message],
    });
    const saved = restoreWorkspace(JSON.parse(JSON.stringify(w)));
    expect(saved.conversations[0].messages[0].compactions).toEqual(message.compactions);
    expect(historyFor(saved.conversations[0])).toEqual([{ role: 'assistant', text: 'Answer' }]);
    const base = sharedWorkspace(saved),
      old = structuredClone(base);
    delete old.conversations[0].messages[0].compactions;
    for (const merged of [
      mergeShared(base, base, old),
      mergeShared(base, old, base),
      mergeShared(emptyShared(), base, old),
    ])
      expect(merged.conversations[0].messages[0].compactions).toEqual(message.compactions);
    old.conversations[0].messages[0].runId = crypto.randomUUID();
    expect(mergeShared(base, base, old).conversations[0].messages[0].compactions).toBeUndefined();
  });
  it('does not revive an older context reading after a boundary and accepts a subsequent reading', () => {
    const w = initialWorkspace(),
      settings = settingsFor(w.preferences),
      message = reply();
    message.settings = settings;
    applyRunEvent(message, event(2, 'complete'));
    message.usage = { revision: 1, contextInput: 90000 }; // an older checkpoint
    const c = {
      id: crypto.randomUUID(),
      title: '',
      createdAt: '',
      updatedAt: '',
      settings,
      messages: [message],
    };
    expect(contextFor(c, settings, '', fallbackModels.codex[0]).reported).toBeNull();
    message.usage = { revision: 2, contextInput: 6000 };
    expect(contextFor(c, settings, '', fallbackModels.codex[0]).reported).toBe(6000);
    expect(compactionLabel(event().compaction!, 'cancelled')).toContain('not confirmed');
  });
  it('rejects malformed events, ignores user targets, and bounds retained metadata', () => {
    const m = reply(),
      events: RunEvent[] = [];
    applyRunEvent(m, { ...event(), compaction: { ...event().compaction!, preTokens: -1 } });
    expect(m.compactions).toBeUndefined();
    m.role = 'user';
    applyRunEvent(m, event());
    expect(m.compactions).toBeUndefined();
    m.role = 'assistant';
    for (let i = 0; i < 50; i++) {
      const e = { ...event(), compaction: { ...event().compaction!, id: `c${i}` } };
      applyRunEvent(m, e);
      retainRunEvent(events, e);
    }
    expect(m.compactions).toHaveLength(32);
    expect(events).toHaveLength(32);
  });
});
