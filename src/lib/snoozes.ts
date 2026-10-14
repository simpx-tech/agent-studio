import { z } from 'zod';

// A chat snoozed until the desktop app starts again. Snoozing moves it to History; from the next
// start of the app it waits at the top of the sidebar to be opened, snoozed again or closed. The
// workspace keeps one per chat, so every device shows it.
export const snoozeSchema = z.object({
  conversationId: z.string().uuid(),
  // The chat's newest message when it was snoozed. Once another follows it, or it goes, the chat
  // is in use again and no longer snoozed, whatever the clocks of the devices say.
  lastMessageId: z.string().uuid().optional(),
  // When it was snoozed, or snoozed again: the first start of the app after this wakes it.
  at: z.iso.datetime(),
});
export const snoozesSchema = z
  .array(snoozeSchema)
  .refine(
    (snoozes) => new Set(snoozes.map((s) => s.conversationId)).size === snoozes.length,
    'Each chat has one snooze.',
  );
export type Snooze = z.infer<typeof snoozeSchema>;
type Chat = { id: string; messages: readonly { id: string }[] };

/** Snoozes by chat, so a sidebar of many chats looks each one up at once. */
export const snoozeIndex = (snoozes: readonly Snooze[] = []) =>
  new Map(snoozes.map((snooze) => [snooze.conversationId, snooze]));
/** The latest start of the desktop app, on any computer, or `-Infinity` before the first. */
export function latestStart(sessions: readonly { startedAt: string }[] = []): number {
  let latest = -Infinity;
  for (const session of sessions) {
    const at = Date.parse(session.startedAt);
    if (at > latest) latest = at;
  }
  return latest;
}
/**
 * Where a chat's snooze stands: `snoozed` until the app starts again after it, then `due`. A chat
 * used again since, or one this device does not hold, has none.
 */
export function snoozeState(
  snooze: Snooze | undefined,
  chat: Chat | undefined,
  started: number,
): 'snoozed' | 'due' | undefined {
  if (!snooze || !chat || chat.messages.at(-1)?.id !== snooze.lastMessageId) return undefined;
  return started > Date.parse(snooze.at) ? 'due' : 'snoozed';
}
/** The chats whose snooze is due, the most recently snoozed first. */
export function dueSnoozes<T extends Chat>(
  snoozes: readonly Snooze[] = [],
  chat: (id: string) => T | undefined,
  started: number,
): { snooze: Snooze; chat: T }[] {
  return snoozes
    .map((snooze) => ({ snooze, chat: chat(snooze.conversationId) }))
    .filter(
      (due): due is { snooze: Snooze; chat: T } =>
        snoozeState(due.snooze, due.chat, started) === 'due',
    )
    .sort((a, b) => Date.parse(b.snooze.at) - Date.parse(a.snooze.at));
}

/** The order every device stores snoozes in, by chat, so equal lists compare equal as text. */
const stored = (snoozes: Snooze[]) =>
  snoozes.sort((a, b) =>
    a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0,
  );
/**
 * Leaves out the snoozes of chats used again since, which wait for nothing any more. One whose chat
 * this device does not hold stays: its chat may still be on its way from another device.
 */
const current = (snoozes: readonly Snooze[] | undefined, chat: (id: string) => Chat | undefined) =>
  (snoozes ?? []).filter((snooze) => {
    const held = chat(snooze.conversationId);
    return !held || held.messages.at(-1)?.id === snooze.lastMessageId;
  });
/** Snoozes a chat from `now`, or snoozes it again. */
export function withSnooze(
  snoozes: readonly Snooze[] | undefined,
  snoozed: Chat,
  chat: (id: string) => Chat | undefined,
  now = new Date(),
): Snooze[] {
  const lastMessageId = snoozed.messages.at(-1)?.id;
  return stored([
    ...current(snoozes, chat).filter((snooze) => snooze.conversationId !== snoozed.id),
    {
      conversationId: snoozed.id,
      ...(lastMessageId ? { lastMessageId } : {}),
      at: now.toISOString(),
    },
  ]);
}
/** Ends a chat's snooze. */
export const withoutSnooze = (
  snoozes: readonly Snooze[] | undefined,
  conversationId: string,
  chat: (id: string) => Chat | undefined,
): Snooze[] =>
  stored(current(snoozes, chat).filter((snooze) => snooze.conversationId !== conversationId));

const sameSnooze = (a: Snooze | undefined, b: Snooze | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.conversationId === b.conversationId &&
    a.lastMessageId === b.lastMessageId &&
    a.at === b.at);
// The later of two snoozes of one chat, the same one on every device.
function later(a: Snooze, b: Snooze) {
  const difference = Date.parse(a.at) - Date.parse(b.at);
  if (difference) return difference > 0 ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}
/** Whether two lists hold the same snoozes, whatever their order. */
export function sameSnoozes(a: readonly Snooze[] = [], b: readonly Snooze[] = []) {
  if (a.length !== b.length) return false;
  const other = snoozeIndex(b);
  return a.every((snooze) => sameSnooze(snooze, other.get(snooze.conversationId)));
}

/**
 * Keeps each side's changes since the shared base. When both sides snoozed the same chat, the later
 * snooze wins, and an ended snooze yields to one snoozed again. A side without the list predates
 * snoozes (an older relay or app drops them), so its absence removes nothing.
 */
export function mergeSnoozes(
  base: readonly Snooze[] | undefined,
  local: Snooze[] | undefined,
  remote: Snooze[] | undefined,
): Snooze[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = snoozeIndex(base);
  const ours = snoozeIndex(local);
  const theirs = snoozeIndex(remote);
  const merged: Snooze[] = [];
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    let snooze: Snooze | undefined;
    if (sameSnooze(left, right) || sameSnooze(original, right)) snooze = left;
    else if (sameSnooze(original, left)) snooze = right;
    else snooze = left && right ? later(left, right) : (left ?? right);
    if (snooze) merged.push(snooze);
  }
  return stored(merged);
}
