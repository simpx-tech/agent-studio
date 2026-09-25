import { z } from 'zod';

// Each start of the desktop app opens an app session: its saved chats move to History, and the
// chats used until the next start belong to the new session. History groups chats by the session
// they were last used in, the latest start at or before their newest message.
export const maxAppSessions = 1000;
export const appSessionSchema = z.object({
  id: z.string().uuid(),
  // The installation that started, which names its computer.
  environmentId: z.string().uuid(),
  startedAt: z.iso.datetime(),
});
export const appSessionsSchema = z
  .array(appSessionSchema)
  .max(maxAppSessions)
  .refine(
    (sessions) => new Set(sessions.map((session) => session.id)).size === sessions.length,
    'App session IDs must be unique.',
  );
export type AppSession = z.infer<typeof appSessionSchema>;
// The times of a chat that tell when it was used.
type Used = { createdAt: string; messages: readonly { createdAt: string }[] };

/** When a chat was last used: its newest message, or its creation for a fork not sent yet. */
export function lastUsed(conversation: Used): number {
  const times = [conversation.createdAt, conversation.messages.at(-1)?.createdAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

export type SessionTimeline = { session: AppSession; at: number }[];
/** Sessions by start, oldest first. */
export function sessionTimeline(sessions: readonly AppSession[] = []): SessionTimeline {
  return sessions
    .map((session) => ({ session, at: Date.parse(session.startedAt) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at || (a.session.id < b.session.id ? -1 : 1));
}
/** The session a time belongs to: the latest start at or before it. */
export function sessionAt(timeline: SessionTimeline, time: number): AppSession | undefined {
  let low = 0,
    high = timeline.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (timeline[middle].at <= time) low = middle + 1;
    else high = middle;
  }
  return low ? timeline[low - 1].session : undefined;
}
// Every device stores sessions in the same order, so equal lists compare equal as text.
const newest = (sessions: AppSession[]) =>
  sessionTimeline(sessions)
    .slice(-maxAppSessions)
    .map((entry) => entry.session);

/**
 * Records this start. A reload of the same app process keeps its session. This installation's
 * earlier sessions that no chat was last used in are dropped, since History never shows them;
 * another computer's chats may not have arrived yet, so its sessions stay.
 */
export function recordAppSession(
  sessions: AppSession[] | undefined,
  started: AppSession,
  conversations: readonly Used[],
): AppSession[] {
  if (sessions?.some((session) => session.id === started.id)) return sessions;
  const timeline = sessionTimeline(sessions);
  const used = new Set(conversations.map((c) => sessionAt(timeline, lastUsed(c))?.id));
  return newest([
    ...(sessions ?? []).filter(
      (session) => used.has(session.id) || session.environmentId !== started.environmentId,
    ),
    started,
  ]);
}

/**
 * Keeps the sessions either side added since the shared base and drops those either side
 * removed. A side without the list predates app sessions (an older relay or app drops them), so
 * its absence removes nothing.
 */
export function mergeAppSessions(
  base: readonly AppSession[] | undefined,
  local: AppSession[] | undefined,
  remote: AppSession[] | undefined,
): AppSession[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = new Set(base?.map((session) => session.id));
  const ours = new Set(local.map((session) => session.id));
  const theirs = new Set(remote.map((session) => session.id));
  const all = new Map([...remote, ...local].map((session) => [session.id, session]));
  return newest(
    [...all.values()].filter(
      (session) => (ours.has(session.id) && theirs.has(session.id)) || !before.has(session.id),
    ),
  );
}

export const startOfDay = (time: number) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
/** A day named from `now`: Today, Yesterday, a weekday within the last week, else its date. */
export function dayLabel(time: number, now: number): string {
  const date = new Date(time);
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}
/** A session's heading: the day and time the app started. */
export const sessionLabel = (time: number, now: number) =>
  `${dayLabel(time, now)}, ${new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
