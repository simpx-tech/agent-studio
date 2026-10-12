import { dayLabel, startOfDay } from './app-sessions';

/** A day a chat continues on: its name from today, and its full date. */
export type ChatDay = { name: string; date: string };

/**
 * The messages that begin another day than the message before them, by id, each with its day,
 * for the division shown above it. The first message is compared with today, so a chat from
 * today has none and a chat from another day opens with its day. A message without a readable
 * time belongs to the day before it.
 */
export function chatDays(
  messages: readonly { id: string; createdAt: string }[],
  now: number,
): Map<string, ChatDay> {
  const days = new Map<string, ChatDay>();
  let previous = startOfDay(now);
  for (const message of messages) {
    const time = Date.parse(message.createdAt);
    if (!Number.isFinite(time)) continue;
    const day = startOfDay(time);
    if (day !== previous)
      days.set(message.id, {
        name: dayLabel(day, now),
        date: new Date(day).toLocaleDateString([], { dateStyle: 'full' }),
      });
    previous = day;
  }
  return days;
}
