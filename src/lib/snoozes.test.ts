import { describe, expect, it } from 'vitest';
import {
  dueSnoozes,
  latestStart,
  mergeSnoozes,
  sameSnoozes,
  snoozeIndex,
  snoozeState,
  snoozesSchema,
  withSnooze,
  withoutSnooze,
  type Snooze,
} from './snoozes';

type Chat = { id: string; messages: { id: string }[] };
const message = () => ({ id: crypto.randomUUID() as string });
const chat = (messages = 1): Chat => ({
  id: crypto.randomUUID(),
  messages: Array.from({ length: messages }, message),
});
const lookup = (...chats: Chat[]) => {
  const index = new Map(chats.map((c) => [c.id, c]));
  return (id: string) => index.get(id);
};
const snooze = (snoozed: Chat, at: string): Snooze => ({
  conversationId: snoozed.id,
  lastMessageId: snoozed.messages.at(-1)!.id,
  at: new Date(at).toISOString(),
});
const start = (at: string) => ({ startedAt: new Date(at).toISOString() });

describe('snoozes', () => {
  it('wakes a snoozed chat once the app starts again after it', () => {
    const snoozed = chat(2);
    const entry = snooze(snoozed, '2026-10-14T10:00Z');
    const morning = latestStart([start('2026-10-14T09:00Z')]);
    expect(snoozeState(entry, snoozed, morning)).toBe('snoozed');
    // A reload keeps the session, so only a later start wakes it, on any computer.
    expect(snoozeState(entry, snoozed, latestStart([start('2026-10-14T09:00Z')]))).toBe('snoozed');
    const next = latestStart([start('2026-10-14T09:00Z'), start('2026-10-14T18:30Z')]);
    expect(snoozeState(entry, snoozed, next)).toBe('due');
    expect(latestStart([])).toBe(-Infinity);
    expect(snoozeState(entry, snoozed, latestStart())).toBe('snoozed');
    // Used again, it waits for nothing: a message followed, or a rewind took the last one away.
    expect(
      snoozeState(entry, { ...snoozed, messages: [...snoozed.messages, message()] }, next),
    ).toBe(undefined);
    expect(snoozeState(entry, { ...snoozed, messages: snoozed.messages.slice(0, 1) }, next)).toBe(
      undefined,
    );
    // A chat this device does not hold, or one never snoozed, has none.
    expect(snoozeState(entry, undefined, next)).toBeUndefined();
    expect(snoozeState(undefined, snoozed, next)).toBeUndefined();
    // A fork not sent yet has no message, until it gets one.
    const empty = chat(0);
    const [unsent] = withSnooze(undefined, empty, lookup(empty), new Date('2026-10-14T10:00Z'));
    expect(unsent).toEqual({ conversationId: empty.id, at: '2026-10-14T10:00:00.000Z' });
    expect(snoozeState(unsent, empty, next)).toBe('due');
    expect(snoozeState(unsent, { ...empty, messages: [message()] }, next)).toBeUndefined();
  });

  it('lists the due chats, the most recently snoozed first', () => {
    const [first, second, later, used] = [chat(), chat(), chat(), chat()];
    const snoozes = [
      snooze(first, '2026-10-14T08:00Z'),
      snooze(second, '2026-10-14T09:00Z'),
      snooze(later, '2026-10-14T20:00Z'),
      snooze(used, '2026-10-14T09:30Z'),
    ];
    const continued = { ...used, messages: [...used.messages, message()] };
    const due = dueSnoozes(
      snoozes,
      lookup(first, second, later, continued),
      latestStart([start('2026-10-14T19:00Z')]),
    );
    expect(due.map((d) => d.chat)).toEqual([second, first]);
    expect(due.map((d) => d.snooze)).toEqual([snoozes[1], snoozes[0]]);
    expect(dueSnoozes(undefined, lookup(), Infinity)).toEqual([]);
  });

  it('snoozes and ends snoozes, dropping those of chats used again', () => {
    const [a, b, gone] = [chat(), chat(), chat()];
    const at = new Date('2026-10-14T10:00Z');
    const once = withSnooze(undefined, a, lookup(a, b), at);
    expect(once).toEqual([
      { conversationId: a.id, lastMessageId: a.messages[0].id, at: at.toISOString() },
    ]);
    // Snoozing again replaces the chat's snooze; every device stores them by chat.
    const again = withSnooze(withSnooze(once, b, lookup(a, b), at), a, lookup(a, b), new Date());
    expect(again.map((s) => s.conversationId)).toEqual([a.id, b.id].sort());
    expect(snoozeIndex(again).get(a.id)!.at).not.toBe(at.toISOString());
    expect(snoozesSchema.safeParse(again).success).toBe(true);
    // A chat used again since loses its snooze with the next change; one whose chat has not
    // arrived here yet keeps it.
    const elsewhere = snooze(gone, '2026-10-14T09:00Z');
    const continued = { ...b, messages: [...b.messages, message()] };
    const ended = withoutSnooze([...again, elsewhere], a.id, lookup(a, continued));
    expect(ended).toEqual([elsewhere]);
    expect(withoutSnooze(undefined, a.id, lookup())).toEqual([]);
  });

  it('accepts only one well-formed snooze per chat', () => {
    const snoozed = chat();
    const entry = snooze(snoozed, '2026-10-14T10:00Z');
    expect(snoozesSchema.safeParse([entry]).success).toBe(true);
    expect(
      snoozesSchema.safeParse([entry, { ...entry, at: '2026-10-14T11:00:00.000Z' }]).success,
    ).toBe(false);
    expect(snoozesSchema.safeParse([{ ...entry, at: 'tomorrow' }]).success).toBe(false);
    expect(snoozesSchema.safeParse([{ ...entry, conversationId: 'chat' }]).success).toBe(false);
    expect(snoozesSchema.safeParse([{ ...entry, lastMessageId: '' }]).success).toBe(false);
  });

  it('merges snoozes from both sides and keeps them when a side predates them', () => {
    const [kept, ours, theirs] = [chat(), chat(), chat()];
    const shared = snooze(kept, '2026-10-13T09:00Z');
    const base = [shared];
    const local = withSnooze(base, ours, lookup(), new Date('2026-10-14T09:00Z'));
    const remote = withSnooze(base, theirs, lookup(), new Date('2026-10-14T09:05Z'));
    const merged = mergeSnoozes(base, local, remote)!;
    expect(sameSnoozes(merged, [...remote, local.find((s) => s.conversationId === ours.id)!])).toBe(
      true,
    );
    // Stored by chat, so equal lists compare equal as text on every device.
    expect(merged.map((s) => s.conversationId)).toEqual([kept.id, ours.id, theirs.id].sort());
    // An older relay or app drops the list: this device keeps its own.
    expect(mergeSnoozes(base, local, undefined)).toBe(local);
    expect(mergeSnoozes(base, undefined, remote)).toBe(remote);
    expect(mergeSnoozes(undefined, undefined, undefined)).toBeUndefined();
    // Ended on one side and kept on the other, it ends; snoozed again on the other, it stays.
    const again = snooze(kept, '2026-10-14T18:00Z');
    expect(mergeSnoozes(base, [], base)).toEqual([]);
    expect(mergeSnoozes(base, base, [])).toEqual([]);
    expect(mergeSnoozes(base, [], [again])).toEqual([again]);
    expect(mergeSnoozes(base, [again], [])).toEqual([again]);
    // Both snoozed it again: the later snooze, the same on both devices.
    const earlier = snooze(kept, '2026-10-14T17:00Z');
    expect(mergeSnoozes(base, [earlier], [again])).toEqual([again]);
    expect(mergeSnoozes(base, [again], [earlier])).toEqual([again]);
    const tie = { ...earlier, lastMessageId: crypto.randomUUID() };
    expect(mergeSnoozes(base, [earlier], [tie])).toEqual(mergeSnoozes(base, [tie], [earlier]));
  });

  it('compares lists whatever their order', () => {
    const [a, b] = [chat(), chat()];
    const list = [snooze(a, '2026-10-14T09:00Z'), snooze(b, '2026-10-14T10:00Z')];
    expect(sameSnoozes(list, [...list].reverse())).toBe(true);
    expect(sameSnoozes(list, list.slice(1))).toBe(false);
    expect(sameSnoozes(list, [list[0], { ...list[1], at: '2026-10-14T11:00:00.000Z' }])).toBe(
      false,
    );
    expect(sameSnoozes(undefined, [])).toBe(true);
  });
});
