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
import { messageArtifacts } from './artifacts';

const event = (id = 'r1', revision = 1, text = 'Compare **options**.'): RunEvent => ({
  kind: 'reasoning',
  id,
  revision,
  text,
  truncated: false,
});
const reply = (): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: '',
  blocks: [],
});

describe('reasoning history', () => {
  it('reconciles snapshots by identity/revision and keeps reasoning out of answers, artifacts and prompts', () => {
    const message = reply(),
      events: RunEvent[] = [];
    for (const next of [
      event(),
      event('r2'),
      event('r1', 3, '```html\n<h1>Reasoning only</h1>\n```'),
      event('r1', 2, 'Stale'),
      event('r1', 3, 'Duplicate'),
      { kind: 'text', text: 'Answer' } as RunEvent,
    ]) {
      applyRunEvent(message, next);
      retainRunEvent(events, next);
    }
    const replay = reply();
    events.forEach((e) => applyRunEvent(replay, e));
    expect(replay.blocks).toEqual(message.blocks);
    expect(message.blocks).toHaveLength(3);
    expect(messageArtifacts(message)).toEqual([]);
    message.status = 'complete';
    const w = initialWorkspace();
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Reasoning fixture',
      createdAt: '',
      updatedAt: '',
      settings: settingsFor(w.preferences),
      messages: [message],
    });
    const saved = restoreWorkspace(JSON.parse(JSON.stringify(w)));
    expect(saved.conversations[0].messages[0].blocks).toEqual(message.blocks);
    expect(historyFor(saved.conversations[0])).toEqual([{ role: 'assistant', text: 'Answer' }]);
    const base = sharedWorkspace(saved),
      a = structuredClone(base),
      b = structuredClone(base);
    applyRunEvent(a.conversations[0].messages[0], event('r2', 4, 'New reasoning'));
    b.conversations[0].messages[0].blocks = b.conversations[0].messages[0].blocks.filter(
      (block) => block.type !== 'reasoning',
    );
    for (const merged of [
      mergeShared(base, a, b),
      mergeShared(base, b, a),
      mergeShared(a, a, b),
      mergeShared(emptyShared(), a, b),
    ]) {
      expect(merged.conversations).toHaveLength(1);
      expect(
        merged.conversations[0].messages[0].blocks
          .filter((block) => block.type === 'reasoning')
          .map((block) => block.text),
      ).toEqual(['```html\n<h1>Reasoning only</h1>\n```', 'New reasoning']);
    }
    b.conversations[0].messages[0].runId = crypto.randomUUID();
    const differentRun = mergeShared(a, a, b);
    expect(
      differentRun.conversations[0].messages[0].blocks.some((b) => b.type === 'reasoning'),
    ).toBe(false);
  });
  it('bounds retained blocks, rejects malformed data and ignores reasoning on user messages', () => {
    const message = reply(),
      events: RunEvent[] = [];
    for (const invalid of [
      { ...event(), id: '' },
      { ...event(), revision: -1 },
      { ...event(), text: 'x'.repeat(32001) },
      { ...event(), truncated: undefined },
    ]) {
      applyRunEvent(message, invalid);
      retainRunEvent(events, invalid);
    }
    expect(message.blocks).toEqual([]);
    expect(events).toEqual([]);
    message.role = 'user';
    applyRunEvent(message, event());
    expect(message.blocks).toEqual([]);
    message.role = 'assistant';
    for (let i = 0; i < 80; i++) {
      applyRunEvent(message, event(`r${i}`));
      retainRunEvent(events, event(`r${i}`));
    }
    expect(message.blocks).toHaveLength(64);
    expect(events).toHaveLength(64);
    applyRunEvent(message, event('r0', 2, 'Latest'));
    expect(message.blocks[0].text).toBe('Latest');
    retainRunEvent(events, { kind: 'text', text: 'Final answer still retained' });
    expect(events.at(-1)?.text).toBe('Final answer still retained');
  });
});
