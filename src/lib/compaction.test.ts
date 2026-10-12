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
import {
  compactionLabel,
  compactionTokens,
  compactionsSchema,
  mergeCompactions,
} from './compaction';
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
  it('labels a marker by its state and trigger, with the sizes the provider reported', () => {
    const done = event(2, 'complete').compaction!;
    expect(compactionLabel(done, 'complete')).toBe('Context compacted automatically');
    expect(compactionLabel({ ...done, trigger: 'manual' }, 'complete')).toBe('Context compacted');
    expect(compactionLabel(event().compaction!, 'running')).toBe('Compacting context…');
    const before = (90000).toLocaleString(),
      after = (4000).toLocaleString();
    expect(compactionTokens(done)).toBe(`${before} tokens before → ${after} after`);
    expect(compactionTokens({ ...done, postTokens: undefined })).toBe(`${before} tokens before`);
    expect(compactionTokens({ ...done, preTokens: undefined })).toBe('');
  });
  it('records where a compaction began among the reply’s work and keeps that place', () => {
    const message = reply();
    const call = (id: string): RunEvent => ({
      kind: 'tool',
      tool: {
        id,
        revision: 1,
        category: 'tool',
        name: 'Read',
        status: 'complete',
        facts: [],
        sources: [],
        agents: [],
      },
    });
    for (const e of [
      call('read1'),
      { kind: 'progress', id: 'p1', revision: 1, text: 'Checking the folder.' } as RunEvent,
      { kind: 'reasoning', id: 'r1', revision: 1, text: 'Think.', truncated: false } as RunEvent,
      // The answer is not part of the work a marker is placed among.
      { kind: 'text', text: 'Almost there' } as RunEvent,
      event(),
      call('read2'),
      event(2, 'complete'),
      call('read3'),
      // A late copy of the start changes neither its state nor its place.
      event(),
    ])
      applyRunEvent(message, e);
    expect(message.compactions).toEqual([{ ...event(2, 'complete').compaction, after: 3 }]);
    // A place that came with the event, as from the computer that ran the reply, is kept.
    const followed = reply();
    applyRunEvent(followed, call('read1'));
    applyRunEvent(followed, { ...event(), compaction: { ...event().compaction!, after: 7 } });
    expect(followed.compactions![0].after).toBe(7);
    // A marker already held without a place gets none from what the reply recorded since.
    const older = reply();
    older.compactions = [event().compaction!];
    applyRunEvent(older, call('read1'));
    applyRunEvent(older, event(2, 'complete'));
    expect(older.compactions).toEqual([event(2, 'complete').compaction]);
  });
  it('keeps a marker’s place when copies of its reply merge', () => {
    const placed = (after?: number, revision = 2) => [
      {
        ...event(revision, revision > 1 ? 'complete' : 'running').compaction!,
        ...(after == null ? {} : { after }),
      },
    ];
    // The computer that ran the reply counted every entry; a device following it fewer.
    expect(mergeCompactions(placed(4), placed(9))[0].after).toBe(9);
    expect(mergeCompactions(placed(9), placed(4))[0].after).toBe(9);
    // A copy an older relay returns has no place and removes none, whichever copy is newer.
    for (const [left, right] of [
      [placed(4), placed(undefined)],
      [placed(undefined), placed(4)],
      [placed(4, 1), placed(undefined, 2)],
      [placed(undefined, 2), placed(4, 1)],
    ]) {
      const [merged] = mergeCompactions(left, right);
      expect(merged).toMatchObject({
        after: 4,
        revision: Math.max(left[0].revision, right[0].revision),
      });
    }
    expect(mergeCompactions(placed(undefined), placed(undefined))[0]).not.toHaveProperty('after');
    // Through a sync: the relay's copy lacks the place, and this device keeps its own.
    const w = initialWorkspace(),
      settings = settingsFor(w.preferences),
      message = reply();
    message.settings = settings;
    message.status = 'complete';
    message.blocks.push({ type: 'markdown', text: 'Answer' });
    applyRunEvent(message, event(2, 'complete'));
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Test',
      createdAt: '',
      updatedAt: '',
      settings,
      messages: [message],
    });
    const base = sharedWorkspace(restoreWorkspace(JSON.parse(JSON.stringify(w)))),
      stripped = structuredClone(base);
    delete stripped.conversations[0].messages[0].compactions![0].after;
    for (const merged of [
      mergeShared(stripped, base, stripped),
      mergeShared(base, base, stripped),
      mergeShared(emptyShared(), base, stripped),
    ])
      expect(merged.conversations[0].messages[0].compactions![0].after).toBe(0);
    // Two devices that counted differently settle on one place, whichever of them merges, so
    // neither sends its own back after the other's write.
    const further = structuredClone(base);
    further.conversations[0].messages[0].compactions![0].after = 7;
    for (const merged of [
      mergeShared(emptyShared(), base, further),
      mergeShared(emptyShared(), further, base),
      mergeShared(base, base, further),
      mergeShared(further, base, further),
    ])
      expect(merged.conversations[0].messages[0].compactions![0].after).toBe(7);
  });
  it('rejects malformed events, ignores user targets, and keeps every compaction of a reply', () => {
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
    expect(m.compactions).toHaveLength(50);
    expect(compactionsSchema.parse(m.compactions)).toEqual(m.compactions);
    // A remote run's job carries every one of them too.
    expect(events).toHaveLength(50);
  });
});
