import { it, expect } from 'vitest';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  initialWorkspace,
  historyFor,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, sharedWorkspace, mergeShared } from './sync';
import {
  mergeSteeringPlaces,
  placedSteering,
  steeringSchema,
  steeringInputSchema,
  type SteeringPlace,
} from './steering';

it('accepts plain human input of any length, rejecting commands and arbitrary metadata', () => {
  const input = { id: crypto.randomUUID(), text: 'Focus here' };
  expect(steeringInputSchema.safeParse(input).success).toBe(true);
  expect(steeringInputSchema.safeParse({ ...input, text: 'x'.repeat(100_000) }).success).toBe(true);
  for (const text of ['', ' ', '/skill', 'a\0b'])
    expect(steeringInputSchema.safeParse({ ...input, text }).success).toBe(false);
  expect(steeringInputSchema.safeParse({ ...input, images: [] }).success).toBe(false);
  const receipt = { ...input, runId: crypto.randomUUID(), sequence: 1 };
  expect(steeringSchema.safeParse([receipt, receipt]).success).toBe(false);
  // However many a reply receives, however long together.
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...receipt,
    id: crypto.randomUUID(),
    sequence: i + 1,
    text: 'x'.repeat(10_000),
  }));
  expect(steeringSchema.parse(many)).toEqual(many);
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

const first = '00000000-0000-4000-8000-000000000001',
  second = '00000000-0000-4000-8000-000000000002';
const reply = (): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: '',
  blocks: [],
});
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
const steered = (m: Message, id: string, sequence: number, at?: string): RunEvent => ({
  kind: 'steering',
  steering: { id, runId: m.runId!, sequence, text: `Steer ${sequence}` },
  ...(at ? { at } : {}),
});

it('records where a steer arrived among the reply’s work, and when its computer confirmed it', () => {
  const m = reply();
  const at = '2026-10-13T15:04:05.678Z';
  for (const event of [
    call('read1'),
    { kind: 'progress', id: 'p1', revision: 1, text: 'Checking the handler.' } as RunEvent,
    // The answer is not part of the work a steer divides.
    { kind: 'text', text: 'Almost there' } as RunEvent,
    steered(m, second, 1, at),
    call('read2'),
    // Older hosts and imported chats report no time.
    steered(m, first, 2),
    call('read3'),
    // A late copy of the first changes neither its place nor its time.
    steered(m, second, 1, '2026-10-13T16:00:00.000Z'),
  ])
    applyRunEvent(m, event);
  expect(m.steering!.map((s) => s.id)).toEqual([second, first]);
  // One place per steer, in the order of their ids, so every copy holds the same list.
  expect(m.steeringPlaces).toEqual([
    { id: first, after: 3 },
    { id: second, after: 2, at },
  ]);
  expect(placedSteering(m.steering, m.steeringPlaces)).toEqual([
    { ...steered(m, second, 1).steering, after: 2, at },
    { ...steered(m, first, 2).steering, after: 3 },
  ]);
  // A steer already held without a place gets none from what the reply recorded since.
  const older = reply();
  older.steering = [steered(older, first, 1).steering!];
  applyRunEvent(older, call('read1'));
  applyRunEvent(older, steered(older, first, 1, at));
  expect(older.steeringPlaces).toBeUndefined();
  expect(placedSteering(older.steering, older.steeringPlaces)).toEqual(older.steering);
  // Another run's steer leaves neither a receipt nor a place.
  const other = reply();
  applyRunEvent(other, steered(reply(), first, 1, at));
  expect(other.steering).toBeUndefined();
  expect(other.steeringPlaces).toBeUndefined();
  // The job another device follows the reply through carries the time beside the receipt.
  const events: RunEvent[] = [];
  retainRunEvent(events, steered(m, second, 1, at));
  retainRunEvent(events, steered(m, first, 2));
  expect(events).toEqual([steered(m, second, 1, at), steered(m, first, 2)]);
});

it('keeps places beside the receipts, whose shape earlier releases validate strictly', () => {
  const m = reply();
  applyRunEvent(m, steered(m, first, 1, '2026-10-13T15:04:05.678Z'));
  // A receipt with a place of its own would fail every earlier app and relay.
  expect(steeringSchema.safeParse([{ ...m.steering![0], after: 0 }]).success).toBe(false);
  const w = initialWorkspace();
  w.conversations.push({
    id: crypto.randomUUID(),
    title: 'Steered',
    settings: { provider: 'codex', model: '', instructions: '', reasoning: '' },
    createdAt: '',
    updatedAt: '',
    messages: [{ ...m, status: 'complete' }],
  });
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(w)));
  expect(restored.conversations[0].messages[0].steeringPlaces).toEqual(m.steeringPlaces);
  expect(sharedWorkspace(restored).conversations[0].messages[0].steeringPlaces).toEqual(
    m.steeringPlaces,
  );
});

it('keeps a steer’s place when copies of its reply merge', () => {
  const place = (id: string, after: number, at?: string): SteeringPlace => ({
    id,
    after,
    ...(at ? { at } : {}),
  });
  // The computer that ran the reply counted every entry; a device following it fewer.
  expect(mergeSteeringPlaces([place(first, 4)], [place(first, 9)])).toEqual([place(first, 9)]);
  expect(mergeSteeringPlaces([place(first, 9)], [place(first, 4)])).toEqual([place(first, 9)]);
  // A copy without a place, as an older relay returns it, removes none.
  expect(mergeSteeringPlaces([place(first, 4)], undefined)).toEqual([place(first, 4)]);
  expect(mergeSteeringPlaces(undefined, [place(first, 4)])).toEqual([place(first, 4)]);
  // The time comes from the computer that ran the reply; a copy without one takes it.
  expect(mergeSteeringPlaces([place(first, 4)], [place(first, 4, 'b')])).toEqual([
    place(first, 4, 'b'),
  ]);
  expect(mergeSteeringPlaces([place(first, 4, 'b')], [place(first, 4, 'a')])).toEqual([
    place(first, 4, 'a'),
  ]);
  // Whichever copy merges, the list is the same.
  const left = [place(second, 1), place(first, 5, 'a')],
    right = [place(first, 2), place(second, 7, 'c')];
  const settled = [place(first, 5, 'a'), place(second, 7, 'c')];
  expect(mergeSteeringPlaces(left, right)).toEqual(settled);
  expect(mergeSteeringPlaces(right, left)).toEqual(settled);
  expect(mergeSteeringPlaces(settled, settled)).toEqual(settled);

  // Through a sync: the relay's copy lacks the places, and this device keeps its own.
  const w = initialWorkspace(),
    m = reply();
  m.status = 'complete';
  m.blocks.push({ type: 'markdown', text: 'Answer' });
  applyRunEvent(m, call('read1'));
  applyRunEvent(m, steered(m, first, 1, '2026-10-13T15:04:05.678Z'));
  w.conversations.push({
    id: crypto.randomUUID(),
    title: 'Steered',
    settings: { provider: 'codex', model: '', instructions: '', reasoning: '' },
    createdAt: '',
    updatedAt: '',
    messages: [m],
  });
  const base = sharedWorkspace(restoreWorkspace(JSON.parse(JSON.stringify(w)))),
    stripped = structuredClone(base);
  delete stripped.conversations[0].messages[0].steeringPlaces;
  for (const merged of [
    mergeShared(stripped, base, stripped),
    mergeShared(base, base, stripped),
    mergeShared(emptyShared(), base, stripped),
  ])
    expect(merged.conversations[0].messages[0].steeringPlaces).toEqual(m.steeringPlaces);
  // Two devices that counted differently settle on one place, whichever of them merges, so
  // neither sends its own back after the other's write.
  const further = structuredClone(base);
  further.conversations[0].messages[0].steeringPlaces![0].after = 7;
  for (const merged of [
    mergeShared(emptyShared(), base, further),
    mergeShared(emptyShared(), further, base),
    mergeShared(base, base, further),
    mergeShared(further, base, further),
  ])
    expect(merged.conversations[0].messages[0].steeringPlaces).toEqual(
      further.conversations[0].messages[0].steeringPlaces,
    );
});
