import type { Schedule } from './workflow-model';

/**
 * When a workflow's schedule starts runs (docs/WORKFLOWS.md): every N minutes or hours, daily at
 * a time, or weekly on chosen days, in the time zone the editor saved. Each slot's run has an id
 * derived from the workflow, schedule and time, so two computers never start one slot twice.
 */

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};
const formats = new Map<string, Intl.DateTimeFormat>();
function format(timezone: string): Intl.DateTimeFormat {
  let value = formats.get(timezone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hourCycle: 'h23',
      });
    } catch {
      value = format('UTC');
    }
    formats.set(timezone, value);
  }
  return value;
}
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The wall-clock date and time an instant shows in a time zone. */
export function zonedParts(at: number, timezone: string): Parts {
  const parts = Object.fromEntries(
    format(timezone)
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday),
  };
}
/** The instant a wall-clock time names in a time zone, the earlier one when it shows twice. */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // Two corrections settle every offset, daylight saving changes included.
  for (let i = 0; i < 3; i++) {
    const shown = zonedParts(guess, timezone);
    const seen = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    const offset = seen - guess;
    const next = wanted - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const day = 24 * 60 * 60 * 1000;
/** Days since 1970-01-01 of a wall-clock date, for every-N-days schedules. */
const dayNumber = (parts: Pick<Parts, 'year' | 'month' | 'day'>) =>
  Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / day);

/** Whether a daily or weekly schedule runs on a date. */
function runsOn(schedule: Schedule, date: Parts) {
  const interval = Math.max(1, schedule.interval);
  const number = dayNumber(date);
  // 1970-01-01 was a Thursday, so weeks counted this way start on Sunday.
  return schedule.every === 'days'
    ? number % interval === 0
    : schedule.days.includes(date.weekday) && Math.floor((number + 4) / 7) % interval === 0;
}
/** The slots of a schedule's dates from `from` days to `to` days away from `now`. */
function dated(schedule: Schedule, now: number, offsets: number[]): number[] {
  const [hour, minute] = schedule.at.split(':').map(Number);
  const slots: number[] = [];
  for (const offset of offsets) {
    const date = zonedParts(now + offset * day, schedule.timezone);
    if (runsOn(schedule, date))
      slots.push(zonedInstant(date.year, date.month, date.day, hour, minute, schedule.timezone));
  }
  return slots;
}
const span = (schedule: Schedule) => 7 * Math.max(1, schedule.interval) + 1;

/** The latest slot at or before `now`, or null when it is before `since`. */
export function latestSlot(schedule: Schedule, now: number): number | null {
  const since = schedule.since ? Date.parse(schedule.since) : Number.NEGATIVE_INFINITY;
  let slot: number | null = null;
  if (schedule.every === 'minutes' || schedule.every === 'hours') {
    const period =
      Math.max(1, schedule.interval) * (schedule.every === 'minutes' ? 60_000 : 3_600_000);
    slot = Math.floor(now / period) * period;
  } else {
    const past = dated(
      schedule,
      now,
      Array.from({ length: span(schedule) + 1 }, (_, i) => -i),
    ).filter((at) => at <= now);
    slot = past.length ? Math.max(...past) : null;
  }
  return slot != null && slot >= since ? slot : null;
}

/** The next slot after `now`, for showing when a schedule runs next. */
export function nextSlot(schedule: Schedule, now: number): number | null {
  if (schedule.every === 'minutes' || schedule.every === 'hours') {
    const period =
      Math.max(1, schedule.interval) * (schedule.every === 'minutes' ? 60_000 : 3_600_000);
    return (Math.floor(now / period) + 1) * period;
  }
  const ahead = dated(
    schedule,
    now,
    Array.from({ length: span(schedule) + 1 }, (_, i) => i),
  ).filter((at) => at > now);
  return ahead.length ? Math.min(...ahead) : null;
}

/** The id of the run a slot starts: the same on every computer. */
export async function slotRunId(definitionId: string, scheduleId: string, slot: number) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`agent-studio-workflow-slot:${definitionId}:${scheduleId}:${slot}`),
    ),
  ).slice(0, 16);
  // A version 8 UUID: its bits are the hash's own.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A schedule in a few words: Every 2 hours, Daily at 09:00, Mon, Wed at 08:30. */
export function scheduleLabel(schedule: Schedule): string {
  const n = Math.max(1, schedule.interval);
  if (schedule.every === 'minutes') return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  if (schedule.every === 'hours') return n === 1 ? 'Every hour' : `Every ${n} hours`;
  if (schedule.every === 'days')
    return `${n === 1 ? 'Daily' : `Every ${n} days`} at ${schedule.at}`;
  const days = [...schedule.days]
    .sort()
    .map((d) => weekdays[d])
    .join(', ');
  return `${n === 1 ? '' : `Every ${n} weeks, `}${days || 'No days'} at ${schedule.at}`;
}
