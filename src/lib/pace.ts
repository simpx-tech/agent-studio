import type { ChatSettings, Conversation } from './domain';
import {
  isStale,
  percentage,
  resetTime,
  type LimitWindow,
  type UsageSnapshot,
  type contextFor,
} from './usage';

export type PaceTone = 'good' | 'steady' | 'watch' | 'danger' | 'muted';

const day = 86_400_000;

/**
 * Even use of a limit at the time of a reading. A limit longer than a day is shared out by day
 * (requested 2026-11-28: "it should be calculated per day, rather than the exact amount, since
 * I'm not going to be using it 24h"): its window splits into days that each end at the reset's
 * time of day, each with an equal share of the limit, so a night without use costs nothing.
 * Even use then stands anywhere from what the earlier days' shares add up to (`from`) to those
 * shares with today's (`to`). A shorter limit, such as the 5-hour one, is even use at the
 * reading itself, `from` and `to` alike.
 */
export type PaceGuide = {
  /** Whether the limit is shared out by day, being longer than one. */
  daily: boolean;
  from: number;
  to: number;
  /** When today's share ends, in milliseconds, for a limit shared out by day. */
  until: number | null;
};

export type QuotaPace = {
  state: 'below' | 'on-track' | 'ahead' | 'exhausted' | 'unknown';
  label: string;
  tone: PaceTone;
  detail: string;
  advice: string;
  /**
   * The share even use reaches, the bars' recommended fill: by the end of today's share for a
   * limit shared out by day, by the reading for a shorter one.
   */
  expectedPercent: number | null;
  guide: PaceGuide | null;
  projectedPercent: number | null;
  /**
   * What is left for each day until the reset, today's included, or for each hour of a limit
   * shorter than a day.
   */
  allowance: number | null;
  allowanceUnit: 'hour' | 'day';
};

/**
 * How a share used compares with even use (`guide`). A limit shared out by day is ahead of pace
 * past the shares of the days so far, today's included, and below pace short of the earlier
 * days' shares. A shorter one is ahead more than 5 percentage points above even use and below
 * more than 5 under it. A limit used up is reached.
 */
export function guidePace(
  used: number,
  guide: Pick<PaceGuide, 'daily' | 'from' | 'to'>,
): Pick<QuotaPace, 'state' | 'label' | 'tone' | 'detail' | 'advice'> & {
  state: Exclude<QuotaPace['state'], 'unknown'>;
} {
  const margin = guide.daily ? 0 : 5;
  const over = used - guide.to;
  const under = guide.from - used;
  const past = over > margin + 1e-6;
  const short = under > margin + 1e-6;
  const state = used >= 100 ? 'exhausted' : past ? 'ahead' : short ? 'below' : 'on-track';
  const points = (value: number) => `${Math.abs(value).toFixed(1)} percentage points`;
  return {
    state,
    label: {
      below: 'Below pace',
      'on-track': 'On track',
      ahead: 'Ahead of pace',
      exhausted: 'Limit reached',
    }[state],
    tone:
      state === 'exhausted'
        ? 'danger'
        : state === 'ahead'
          ? 'watch'
          : state === 'on-track'
            ? 'steady'
            : 'good',
    detail: guide.daily
      ? past
        ? `${points(over)} past today's share.`
        : short
          ? `${points(under)} of earlier days' shares unused.`
          : "Within today's share."
      : past || short
        ? `${points(over)} ${over > 0 ? 'above' : 'below'} the even-use guide.`
        : 'Within 5 percentage points of the even-use guide.',
    advice:
      state === 'exhausted'
        ? 'Wait for reset or switch provider.'
        : state === 'ahead'
          ? ''
          : state === 'below'
            ? 'Room to spare compared with evenly spread usage.'
            : guide.daily
              ? "Stay within a day's share a day to last until reset."
              : 'Keep usage close to the guide to last until reset.',
  };
}

export function quotaPace(
  window: LimitWindow,
  snapshot: UsageSnapshot | undefined,
  now: number,
  refreshFailed = false,
): QuotaPace {
  const unknown = (detail: string): QuotaPace => ({
    state: 'unknown',
    label: 'Pace unavailable',
    tone: 'muted',
    detail,
    advice: '',
    expectedPercent: null,
    guide: null,
    projectedPercent: null,
    allowance: null,
    allowanceUnit: window.windowMinutes === 300 ? 'hour' : 'day',
  });
  if (!snapshot || window.usedPercent == null || !Number.isFinite(window.usedPercent))
    return unknown('A reported usage percentage is needed to compare pace.');
  if (refreshFailed || isStale(snapshot, window, now))
    return unknown('Waiting for a current usage reading to compare pace.');
  const reset = resetTime(window.resetsAt);
  const duration = (window.windowMinutes ?? 0) * 60_000;
  const measuredAt = (window.checkedAt ?? snapshot.checkedAt) * 1000;
  if (
    !reset ||
    !Number.isFinite(now) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(measuredAt) ||
    measuredAt > now + 60_000 ||
    measuredAt < reset - duration ||
    measuredAt >= reset ||
    now >= reset ||
    window.usedPercent < 0
  )
    return unknown('A valid reset time and window duration are needed to compare pace.');

  // Match the time budget to the timestamp of the quota reading, not the ticking
  // clock: an unchanged or failed reading must not slowly look more favorable.
  const start = reset - duration;
  const share = (time: number) => ((time - start) / duration) * 100;
  const used = window.usedPercent;
  const left = Math.max(0, 100 - used);
  const elapsed = share(measuredAt);
  // A projection from the first few moments of a window is too unstable to show.
  const projected = elapsed >= 5 ? (used / elapsed) * 100 : null;
  if (duration > day) {
    // The days until the reset, today's included, each ending at the reset's time of day.
    const days = daysUntil(reset, measuredAt);
    const until = reset - (days - 1) * day;
    const guide = {
      daily: true,
      from: share(Math.max(start, until - day)),
      to: share(until),
      until,
    };
    return {
      ...guidePace(used, guide),
      expectedPercent: guide.to,
      guide,
      projectedPercent: projected,
      allowance: left / days,
      allowanceUnit: 'day',
    };
  }
  const guide = { daily: false, from: elapsed, to: elapsed, until: null };
  return {
    ...guidePace(used, guide),
    expectedPercent: elapsed,
    guide,
    projectedPercent: projected,
    allowance: left / ((reset - measuredAt) / 3_600_000),
    allowanceUnit: 'hour',
  };
}

/**
 * The days from `time` until `reset`, the one under way included, each ending at the reset's
 * time of day.
 */
export const daysUntil = (reset: number, time: number) =>
  Math.max(1, Math.ceil((reset - time) / day));

/**
 * The recommendation a quota bar's hover and value give: by the end of today's share for a
 * limit shared out by day (`recommended 57.1% by 21:00`), at the reading for a shorter one.
 */
export function recommendation(pace: QuotaPace, now: number) {
  if (pace.expectedPercent == null) return '';
  const value = `recommended ${percentage(pace.expectedPercent)}`;
  if (!pace.guide?.until) return value;
  const date = new Date(pace.guide.until);
  const clock = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return date.toDateString() === new Date(now).toDateString()
    ? `${value} by ${clock}`
    : `${value} by ${date.toLocaleDateString([], { weekday: 'long' })}, ${clock}`;
}

/** A quota bar's hover: the share used beside the recommendation, or what keeps it from one. */
export function recommendationTitle(used: number, pace: QuotaPace, now: number) {
  if (pace.expectedPercent == null) return pace.detail;
  const when = pace.guide?.daily ? '' : ' at the time of this reading';
  return `${percentage(used)} used; ${recommendation(pace, now)}${when}.`;
}

type Context = ReturnType<typeof contextFor>;
export type ContextPace = {
  state: 'room' | 'growing' | 'watch' | 'near' | 'full' | 'unknown';
  label: string;
  tone: PaceTone;
  advice: string;
  remainingTokens: number | null;
  growthPerReply: number | null;
  growthSamples: number;
  repliesToWarning: number | null;
};
const matching = (a: ChatSettings | undefined, b: ChatSettings) =>
  a?.provider === b.provider &&
  a.model === b.model &&
  a.reasoning === b.reasoning &&
  a.instructions === b.instructions;

export function contextPace(
  conversation: Conversation | undefined,
  settings: ChatSettings,
  context: Context,
): ContextPace {
  const empty: ContextPace = {
    state: 'unknown',
    label: 'Status unavailable',
    tone: 'muted',
    advice: 'Measured context and a known window are needed to assess room.',
    remainingTokens: null,
    growthPerReply: null,
    growthSamples: 0,
    repliesToWarning: null,
  };
  if (
    context.reported == null ||
    context.capacity == null ||
    context.capacity <= 0 ||
    context.percent == null
  )
    return empty;

  const points: number[] = [];
  let latestModel: string | null | undefined;
  for (let i = (conversation?.messages.length ?? 0) - 1; i >= 0 && points.length < 6; i--) {
    const message = conversation!.messages[i];
    if (message.role !== 'assistant') continue;
    if (message.compact || message.compactions?.some((c) => c.status === 'complete')) break;
    if (!points.length && message.status === 'running' && message.usage?.contextInput == null)
      continue;
    const count = message.usage?.contextInput;
    if (
      !matching(message.settings, settings) ||
      count == null ||
      !Number.isFinite(count) ||
      count < 0
    )
      break;
    if (message.usage?.contextWindow != null && message.usage.contextWindow !== context.capacity)
      break;
    if (points.length && (message.usage?.model !== latestModel || count > points.at(-1)!)) break;
    // A decrease can mean compaction or a reset. Start a new trend after it.
    latestModel = message.usage?.model;
    points.push(count);
  }
  const samples = Math.max(0, points.length - 1);
  const growth = samples >= 2 ? (points[0] - points.at(-1)!) / samples : null;
  const toWarning =
    growth != null && growth > 0
      ? Math.max(0, Math.ceil((context.capacity * 0.8 - context.reported) / growth))
      : null;
  const used = context.percent;
  const state =
    used >= 100
      ? 'full'
      : used >= 90
        ? 'near'
        : used >= 80
          ? 'watch'
          : toWarning != null && toWarning <= 3
            ? 'growing'
            : 'room';
  return {
    state,
    label: {
      room: 'Room available',
      growing: 'Growing quickly',
      watch: 'Watch context',
      near: 'Nearly full',
      full: 'At capacity',
    }[state],
    tone:
      state === 'full' || state === 'near'
        ? 'danger'
        : state === 'watch' || state === 'growing'
          ? 'watch'
          : 'good',
    remainingTokens: Math.max(0, context.capacity - context.reported),
    growthPerReply: growth,
    growthSamples: samples,
    repliesToWarning: toWarning,
    advice:
      state === 'full'
        ? 'Start a new chat with a summary before continuing.'
        : state === 'near'
          ? 'Start a new chat soon; carry over a short summary.'
          : state === 'watch' || state === 'growing'
            ? 'Summarize and start a new chat soon.'
            : 'There is room to continue this chat.',
  };
}

export function forecastWarning(
  context: Context,
): { label: string; tone: PaceTone; advice: string } | null {
  const percent = context.estimatedPercent;
  if (percent == null || percent < 80) return null;
  return {
    label:
      percent >= 100
        ? 'Estimate exceeds window'
        : percent >= 90
          ? 'Estimate nearly full'
          : 'Estimate above 80%',
    tone: percent >= 90 ? 'danger' : 'watch',
    advice:
      percent >= 90
        ? 'Shorten the draft or start a new chat before sending.'
        : 'Keep the next message focused; consider a new chat soon.',
  };
}
