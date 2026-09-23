import { describe, expect, it } from 'vitest';
import { conversationSchema, historyFor, type Conversation } from './domain';
import { rewindConversation, undoRewind } from './rewind';
import { emptyShared, mergeShared } from './sync';
import { forkConversation } from './forks';

function chat(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Rewind',
    createdAt: '2026-09-19',
    updatedAt: '2026-09-19',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: ['First question', 'First answer', 'Second question', 'Second answer'].map(
      (text, i) => ({
        id: crypto.randomUUID(),
        role: i % 2 ? 'assistant' : 'user',
        status: 'complete',
        createdAt: '2026-09-19',
        blocks: [{ type: 'markdown', text }],
        ...(i % 2 ? { runId: crypto.randomUUID(), durationMs: 500 } : {}),
      }),
    ),
  };
}
describe('rewinding saved conversations', () => {
  it('forks only retained messages and leaves the source rewind independently recoverable', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const fork = forkConversation(rewound);
    expect(fork.messages).toHaveLength(2);
    expect(fork.historyRevision).toBeUndefined();
    expect(fork.rewind).toBeUndefined();
    expect(undoRewind(rewound).messages).toEqual(original.messages);
    expect(fork.messages).toHaveLength(2);
  });
  it('keeps removed messages recoverable through validation and export, without replaying them', () => {
    const original = chat();
    const rewound = conversationSchema.parse(rewindConversation(original, original.messages[2].id));
    expect(rewound.messages).toEqual(original.messages.slice(0, 2));
    expect(historyFor(rewound).map((m) => m.text)).toEqual(['First question', 'First answer']);
    expect(rewound.historyRevision).toBe(1);
    const restored = undoRewind(JSON.parse(JSON.stringify(rewound)));
    expect(restored.messages).toEqual(original.messages);
    expect(restored.settings).toEqual(original.settings);
    expect(restored.historyRevision).toBe(2);
    expect(restored.rewind).toBeUndefined();
  });
  it('supports the first message and repeated rewinds without losing the suffix', () => {
    const original = chat();
    const once = rewindConversation(original, original.messages[2].id);
    const twice = rewindConversation(once, original.messages[0].id);
    expect(twice.messages).toEqual([]);
    expect(undoRewind(twice).messages).toEqual(original.messages);
  });
  it('rejects running, stale, and assistant targets', () => {
    const original = chat();
    expect(() => rewindConversation(original, crypto.randomUUID())).toThrow();
    expect(() => rewindConversation(original, original.messages[1].id)).toThrow();
    original.messages[3].status = 'running';
    expect(() => rewindConversation(original, original.messages[0].id)).toThrow(/finish/);
  });
  it('does not resurrect removed turns when an old checkpoint arrives', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const stale = structuredClone(original);
    stale.updatedAt = '2026-09-20';
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [rewound] },
      { ...base, conversations: [stale] },
    );
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].messages).toHaveLength(2);
    const reverse = mergeShared(
      base,
      { ...base, conversations: [stale] },
      { ...base, conversations: [rewound] },
    );
    expect(reverse.conversations[0].messages).toHaveLength(2);
  });
  it('keeps a concurrent deliberate edit as a conflict copy while retaining the rewind identity', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const changed = structuredClone(original);
    changed.messages.push({ ...original.messages[0], id: crypto.randomUUID() });
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [rewound] },
      { ...base, conversations: [changed] },
    );
    expect(result.conversations.find((c) => c.id === original.id)?.messages).toHaveLength(2);
    expect(result.conversations.find((c) => c.id !== original.id)?.messages).toHaveLength(5);
  });
  it('keeps a one-sided archive from another device without a conflict copy', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const archived = { ...structuredClone(original), archived: true };
    const base = { ...emptyShared(), conversations: [original] };
    for (const [local, remote] of [
      [rewound, archived],
      [archived, rewound],
    ]) {
      const result = mergeShared(
        base,
        { ...base, conversations: [local] },
        { ...base, conversations: [remote] },
      );
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].messages).toHaveLength(2);
      expect(result.conversations[0].archived).toBe(true);
      expect(undoRewind(result.conversations[0]).messages).toEqual(original.messages);
    }
  });
  it('tells the agent when the user undid recorded file edits', () => {
    const original = chat();
    original.messages[1].filesUndone = true;
    expect(historyFor(original)[1].text).toContain('user undid');
  });
  it('preserves concurrent rewinds as separate histories even at the same revision', () => {
    const original = chat();
    const a = rewindConversation(original, original.messages[0].id);
    const b = rewindConversation(original, original.messages[2].id);
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [a] },
      { ...base, conversations: [b] },
    );
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations.map((c) => c.messages.length).sort()).toEqual([0, 2]);
    for (const conversation of result.conversations)
      expect(undoRewind(conversation).messages).toEqual(original.messages);
  });
});
