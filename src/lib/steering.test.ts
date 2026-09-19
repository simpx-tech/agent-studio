import { it, expect } from 'vitest';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  initialWorkspace,
  historyFor,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { sharedWorkspace, mergeShared } from './sync';
import { steeringSchema, steeringInputSchema } from './steering';

it('bounds plain human input, rejecting commands and arbitrary metadata', () => {
  const input = { id: crypto.randomUUID(), text: 'Focus here' };
  expect(steeringInputSchema.safeParse(input).success).toBe(true);
  for (const text of ['', ' ', '/skill', 'x'.repeat(30001), 'a\0b'])
    expect(steeringInputSchema.safeParse({ ...input, text }).success).toBe(false);
  expect(steeringInputSchema.safeParse({ ...input, images: [] }).success).toBe(false);
  const receipt = { ...input, runId: crypto.randomUUID(), sequence: 1 };
  expect(steeringSchema.safeParse([receipt, receipt]).success).toBe(false);
});

it('persists only matching receipts, deduplicates checkpoints, and keeps failed-turn guidance during sync', () => {
  const w = initialWorkspace();
  const m: Message = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant',
    status: 'cancelled',
    createdAt: '',
    blocks: [],
  };
  const event: RunEvent = {
    kind: 'steering',
    steering: {
      id: crypto.randomUUID(),
      runId: m.runId!,
      sequence: 1,
      text: 'Preserve the existing file',
    },
  };
  applyRunEvent(m, { ...event, steering: { ...event.steering!, runId: crypto.randomUUID() } });
  expect(m.steering).toBeUndefined();
  applyRunEvent(m, event);
  applyRunEvent(m, event);
  expect(m.steering).toHaveLength(1);
  const events: RunEvent[] = [];
  retainRunEvent(events, event);
  retainRunEvent(events, event);
  expect(events).toHaveLength(1);
  w.conversations.push({
    id: crypto.randomUUID(),
    title: 'Steered',
    settings: { provider: 'codex', model: '', instructions: '', reasoning: '' },
    createdAt: '',
    updatedAt: '',
    messages: [m],
  });
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(w)));
  expect(historyFor(restored.conversations[0])[0].text).toContain('Preserve the existing file');
  const base = sharedWorkspace(w),
    old = structuredClone(base);
  delete old.conversations[0].messages[0].steering;
  old.conversations[0].updatedAt = 'later';
  const merged = mergeShared(base, base, old);
  expect(merged.conversations).toHaveLength(1);
  expect(merged.conversations[0].messages[0].steering).toEqual(m.steering);
});
