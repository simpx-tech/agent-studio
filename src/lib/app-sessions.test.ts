import { describe, expect, it } from 'vitest';
import {
  appSessionsSchema,
  dayLabel,
  lastUsed,
  maxAppSessions,
  mergeAppSessions,
  recordAppSession,
  sessionAt,
  sessionLabel,
  sessionTimeline,
  type AppSession,
} from './app-sessions';

const environmentId = crypto.randomUUID();
const session = (startedAt: string): AppSession => ({
  id: crypto.randomUUID(),
  environmentId,
  startedAt: new Date(startedAt).toISOString(),
});
const chat = (createdAt: string, ...messages: string[]) => ({
  createdAt: new Date(createdAt).toISOString(),
  messages: messages.map((time) => ({ createdAt: new Date(time).toISOString() })),
});

describe('app sessions', () => {
  it('finds the session each chat was last used in', () => {
    const [first, second] = [session('2026-09-24T09:00'), session('2026-09-25T09:00')];
    const timeline = sessionTimeline([second, first]);
    expect(timeline.map((entry) => entry.session)).toEqual([first, second]);
    // The newest message counts; a fork not sent yet counts from its creation.
    const reopened = chat('2026-09-24T10:00', '2026-09-24T10:00', '2026-09-25T11:00');
    expect(lastUsed(reopened)).toBe(Date.parse('2026-09-25T11:00'));
    expect(lastUsed(chat('2026-09-25T12:00', '2026-09-20T10:00'))).toBe(
      Date.parse('2026-09-25T12:00'),
    );
    expect(lastUsed({ createdAt: '', messages: [] })).toBeNaN();
    expect(sessionAt(timeline, lastUsed(reopened))).toBe(second);
    expect(sessionAt(timeline, Date.parse('2026-09-24T09:00'))).toBe(first);
    expect(sessionAt(timeline, Date.parse('2026-09-24T23:59'))).toBe(first);
    // Chats from before the first recorded start have no session.
    expect(sessionAt(timeline, Date.parse('2026-09-23T20:00'))).toBeUndefined();
    expect(sessionAt(timeline, NaN)).toBeUndefined();
  });

  it('records each start once and drops earlier sessions without chats', () => {
    const used = session('2026-09-24T09:00');
    const empty = session('2026-09-24T18:00');
    // Another computer's chats may still be on their way, so only this one's sessions go.
    const elsewhere = { ...session('2026-09-24T20:00'), environmentId: crypto.randomUUID() };
    const chats = [chat('2026-09-24T09:05', '2026-09-24T09:05')];
    const started = session('2026-09-25T09:00');
    const sessions = recordAppSession([elsewhere, empty, used], started, chats);
    expect(sessions).toEqual([used, elsewhere, started]);
    // A page reload keeps the session of its app process.
    expect(recordAppSession(sessions, started, chats)).toBe(sessions);
    expect(recordAppSession(undefined, started, [])).toEqual([started]);
    // The newest starts are kept, in the same order on every device.
    const many = Array.from({ length: maxAppSessions }, (_, i) =>
      session(new Date(Date.parse('2026-01-01') + i * 3_600_000).toISOString()),
    );
    const everyUsed = many.map((s) => chat(s.startedAt, s.startedAt));
    const kept = recordAppSession([...many].reverse(), started, everyUsed);
    expect(kept).toHaveLength(maxAppSessions);
    expect(kept[0]).toBe(many[1]);
    expect(kept.at(-1)).toBe(started);
    expect(appSessionsSchema.safeParse(kept).success).toBe(true);
    expect(appSessionsSchema.safeParse([...kept, started]).success).toBe(false);
    expect(appSessionsSchema.safeParse([{ ...started, startedAt: 'yesterday' }]).success).toBe(
      false,
    );
  });

  it('merges sessions from both sides and keeps them when a side predates them', () => {
    const [shared, removed, ours, theirs] = [
      session('2026-09-22T09:00'),
      session('2026-09-23T09:00'),
      session('2026-09-24T09:00'),
      session('2026-09-25T09:00'),
    ];
    const base = [shared, removed];
    // A start on each side is kept; one that a side dropped since the base goes.
    expect(mergeAppSessions(base, [shared, ours], [shared, removed, theirs])).toEqual([
      shared,
      ours,
      theirs,
    ]);
    expect(mergeAppSessions(undefined, [ours], [theirs])).toEqual([ours, theirs]);
    // An older relay or app drops the list: nothing was removed.
    expect(mergeAppSessions(base, [shared, ours], undefined)).toEqual([shared, ours]);
    expect(mergeAppSessions(base, undefined, [theirs])).toEqual([theirs]);
    expect(mergeAppSessions(undefined, undefined, undefined)).toBeUndefined();
  });

  it('names a session by the day and time the app started', () => {
    const now = new Date(2026, 8, 25, 15, 30).getTime();
    const at = (day: number, hour = 9, month = 8, year = 2026) =>
      new Date(year, month, day, hour, 14).getTime();
    const time = (value: number) =>
      new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(sessionLabel(at(25), now)).toBe(`Today, ${time(at(25))}`);
    expect(sessionLabel(at(24, 23), now)).toBe(`Yesterday, ${time(at(24, 23))}`);
    expect(dayLabel(at(24, 0), now)).toBe('Yesterday');
    expect(dayLabel(at(21), now)).toBe(
      new Date(at(21)).toLocaleDateString([], { weekday: 'long' }),
    );
    expect(dayLabel(at(18), now)).toBe(
      new Date(at(18)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    );
    expect(dayLabel(at(30, 9, 11, 2025), now)).toBe(
      new Date(at(30, 9, 11, 2025)).toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
  });
});
