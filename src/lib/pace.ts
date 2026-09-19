import type { ChatSettings, Conversation } from './domain';
import { isStale, resetTime, type LimitWindow, type UsageSnapshot, type contextFor } from './usage';

export type PaceTone = 'good' | 'steady' | 'watch' | 'danger' | 'muted';
export type QuotaPace = {
  state: 'below' | 'on-track' | 'ahead' | 'exhausted' | 'unknown';
  label: string;
  tone: PaceTone;
  detail: string;
  advice: string;
  expectedPercent: number | null;
  projectedPercent: number | null;
  allowance: number | null;
  allowanceUnit: 'hour' | 'day';
};

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
  const measuredAt = snapshot.checkedAt * 1000;
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
  const expected = ((measuredAt - (reset - duration)) / duration) * 100;
  const used = window.usedPercent;
  const difference = used - expected;
  const state =
    used >= 100
      ? 'exhausted'
      : difference > 5 + 1e-6
        ? 'ahead'
        : difference < -5 - 1e-6
          ? 'below'
          : 'on-track';
  const unit = window.windowMinutes === 300 || reset - measuredAt < 86_400_000 ? 'hour' : 'day';
  const remainingUnits = (reset - measuredAt) / (unit === 'hour' ? 3_600_000 : 86_400_000);
  // A projection from the first few moments of a window is too unstable to show.
  const projected = expected >= 5 ? (used / expected) * 100 : null;
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
    expectedPercent: expected,
    projectedPercent: projected,
    allowance: Math.max(0, 100 - used) / remainingUnits,
    allowanceUnit: unit,
    detail:
      state === 'on-track'
        ? 'Within 5 percentage points of the even-use guide.'
        : `${Math.abs(difference).toFixed(1)} percentage points ${difference > 0 ? 'above' : 'below'} the even-use guide.`,
    advice:
      state === 'exhausted'
        ? 'Wait for reset or switch provider.'
        : state === 'ahead'
          ? ''
          : state === 'below'
            ? 'Room to spare compared with evenly spread usage.'
            : 'Keep usage close to the guide to last until reset.',
  };
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
