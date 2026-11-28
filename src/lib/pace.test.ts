import { describe, expect, it } from 'vitest';
import {
  contextPace,
  forecastWarning,
  quotaPace,
  recommendation,
  recommendationTitle,
} from './pace';
import { contextFor, type LimitWindow, type UsageSnapshot } from './usage';
import { initialWorkspace, settingsFor, type Conversation } from './domain';
import { automaticModel } from './models';

const now = Date.parse('2026-09-08T12:00:00Z');
const window: LimitWindow = {
  id: '5h',
  label: '5-hour',
  bucket: 'claude',
  model: null,
  usedPercent: 70,
  resetsAt: (now + 2.5 * 3_600_000) / 1000,
  windowMinutes: 300,
};
const snapshot: UsageSnapshot = {
  provider: 'claude',
  checkedAt: now / 1000,
  windows: [window],
  context: null,
  detail: '',
};
const settings = {
  ...settingsFor(initialWorkspace().preferences),
  provider: 'claude' as const,
  model: 'haiku',
};
function chat(readings: (number | null)[]): Conversation {
  return {
    id: crypto.randomUUID(),
    settings,
    title: 'Pace fixture',
    createdAt: '',
    updatedAt: '',
    messages: readings.map((n) => ({
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'complete',
      createdAt: '',
      settings,
      blocks: [{ type: 'markdown', text: 'A measured reply.' }],
      usage: {
        contextInput: n,
        input: 999999,
        output: 100,
        contextWindow: 100000,
        model: 'claude-haiku',
      },
    })),
  };
}
const health = (c: Conversation, draft = '') =>
  contextPace(c, settings, contextFor(c, settings, draft, automaticModel));

describe('quota pace', () => {
  it('classifies pace around an even-use guide and calculates a remaining allowance', () => {
    for (const [used, state] of [
      [30, 'below'],
      [45, 'on-track'],
      [55, 'on-track'],
      [56, 'ahead'],
      [100, 'exhausted'],
    ] as const)
      expect(quotaPace({ ...window, usedPercent: used }, snapshot, now).state).toBe(state);
    expect(quotaPace(window, snapshot, now)).toMatchObject({
      state: 'ahead',
      expectedPercent: 50,
      projectedPercent: 140,
      allowance: 12,
      allowanceUnit: 'hour',
      tone: 'watch',
    });
    expect(quotaPace(window, snapshot, now).advice).toBe('');
    const week = {
      ...window,
      model: 'fable',
      windowMinutes: 10080,
      usedPercent: 50,
      resetsAt: new Date(now + 5 * 86_400_000).toISOString(),
    };
    expect(quotaPace(week, snapshot, now)).toMatchObject({
      state: 'ahead',
      allowance: 10,
      allowanceUnit: 'day',
    });
    expect(quotaPace(week, snapshot, now).projectedPercent).toBeCloseTo(175, 8);
  });
  it('shares a limit longer than a day out by day, each ending at its reset’s time of day', () => {
    const day = 86_400_000;
    // Halfway through a week: the reset is 3.5 days away, so today is the fourth of seven days
    // and ends 12 hours from now, when the shares of four days add up to 57.1%.
    const week = (used: number, resetIn = 3.5 * day): LimitWindow => ({
      ...window,
      id: 'week',
      label: 'Weekly',
      windowMinutes: 10080,
      usedPercent: used,
      resetsAt: (now + resetIn) / 1000,
    });
    const pace = quotaPace(week(50), snapshot, now);
    expect(pace).toMatchObject({
      state: 'on-track',
      guide: { daily: true, until: now + 12 * 3_600_000 },
      allowance: 12.5,
      allowanceUnit: 'day',
      detail: "Within today's share.",
    });
    expect(pace.guide!.from).toBeCloseTo(300 / 7, 8);
    expect(pace.expectedPercent).toBeCloseTo(400 / 7, 8);
    // Anywhere between the earlier days' shares and today's is on track, however little or much
    // of today has passed.
    for (const [used, state] of [
      [42.8, 'below'],
      [43, 'on-track'],
      [57, 'on-track'],
      [57.2, 'ahead'],
      [100, 'exhausted'],
    ] as const)
      expect(quotaPace(week(used), snapshot, now).state).toBe(state);
    // A night without use costs nothing: ten hours later the same reading still stands where the
    // day left it, where an even-use guide that never sleeps would have moved 6 points on.
    const later = now + 10 * 3_600_000;
    const night = quotaPace(week(57), { ...snapshot, checkedAt: later / 1000 }, later);
    expect(night.state).toBe('on-track');
    expect(night.expectedPercent).toBeCloseTo(400 / 7, 8);
    expect(quotaPace(week(60), snapshot, now).detail).toBe(
      "2.9 percentage points past today's share.",
    );
    // The report of 2026-11-28: 75% used with less than a day to go is short of the earlier
    // days' shares, and all that is left is today's.
    const last = quotaPace(week(75, 20 * 3_600_000), snapshot, now);
    expect(last).toMatchObject({
      state: 'below',
      expectedPercent: 100,
      allowance: 25,
      allowanceUnit: 'day',
      detail: "10.7 percentage points of earlier days' shares unused.",
      guide: { until: now + 20 * 3_600_000 },
    });
    // The first day of a week, from its very start.
    expect(quotaPace(week(10, 7 * day), snapshot, now)).toMatchObject({
      state: 'on-track',
      guide: { from: 0 },
      allowance: 90 / 7,
    });
    expect(quotaPace(week(15, 7 * day), snapshot, now).state).toBe('ahead');
    // The bars name when today's share ends, and a shorter limit keeps the reading's guide.
    const until = pace.guide!.until!;
    expect(recommendation(pace, until)).toMatch(/^recommended 57\.1% by [^,]+$/);
    expect(recommendation(last, last.guide!.until! - 2 * day)).toMatch(
      /^recommended 100% by \S+, \S/,
    );
    expect(recommendationTitle(50, pace, now)).toMatch(/^50% used; recommended 57\.1% by .+\.$/);
    expect(recommendationTitle(70, quotaPace(window, snapshot, now), now)).toBe(
      '70% used; recommended 50% at the time of this reading.',
    );
  });
  it('aligns the comparison to the reading and withholds unstable early projections', () => {
    expect(quotaPace(window, snapshot, now + 120000).expectedPercent).toBe(50);
    const early = { ...window, usedPercent: 20, resetsAt: (now + 4.9 * 3_600_000) / 1000 };
    expect(quotaPace(early, snapshot, now)).toMatchObject({
      state: 'ahead',
      projectedPercent: null,
    });
    const first = { ...window, usedPercent: 0, resetsAt: (now + 5 * 3_600_000) / 1000 };
    expect(quotaPace(first, snapshot, now)).toMatchObject({
      state: 'on-track',
      projectedPercent: null,
      allowance: 20,
    });
  });
  it('never gives a reassuring pace for missing, stale, failed, or invalid readings', () => {
    expect(quotaPace(window, undefined, now).state).toBe('unknown');
    expect(quotaPace(window, snapshot, now, true).state).toBe('unknown');
    expect(quotaPace(window, snapshot, now + 180001).state).toBe('unknown');
    for (const changed of [
      { ...window, usedPercent: null },
      { ...window, usedPercent: NaN },
      { ...window, resetsAt: null },
      { ...window, resetsAt: 'invalid' },
      { ...window, resetsAt: now / 1000 },
      { ...window, windowMinutes: null },
      { ...window, resetsAt: (now + 6 * 3_600_000) / 1000 },
    ])
      expect(quotaPace(changed, snapshot, now).state).toBe('unknown');
    expect(quotaPace(window, { ...snapshot, checkedAt: now / 1000 + 120 }, now).state).toBe(
      'unknown',
    );
  });
});

describe('context capacity and measured growth', () => {
  it('provides room and capacity guidance without inventing a timed reset', () => {
    for (const [reading, state] of [
      [0, 'room'],
      [79000, 'room'],
      [80000, 'watch'],
      [90000, 'near'],
      [100000, 'full'],
    ] as const)
      expect(health(chat([reading])).state).toBe(state);
    expect(health(chat([90000]))).toMatchObject({
      remainingTokens: 10000,
      growthPerReply: null,
      tone: 'danger',
    });
    expect(health(chat([null]))).toMatchObject({ state: 'unknown', remainingTokens: null });
  });
  it('projects from consecutive measured growth and flags rapidly filling context', () => {
    expect(health(chat([20000, 30000, 40000]))).toMatchObject({
      state: 'room',
      growthPerReply: 10000,
      growthSamples: 2,
      repliesToWarning: 4,
    });
    expect(health(chat([20000, 40000, 60000]))).toMatchObject({
      state: 'growing',
      growthPerReply: 20000,
      repliesToWarning: 1,
      tone: 'watch',
    });
    expect(health(chat([1000, 1000, 1000]))).toMatchObject({
      growthPerReply: 0,
      repliesToWarning: null,
    });
    expect(health(chat([1000, 2000])).growthPerReply).toBeNull();
  });
  it('restarts trends after missing data, changed models/settings/windows, or a context decrease', () => {
    expect(health(chat([1000, 2000, 500])).growthPerReply).toBeNull();
    expect(health(chat([1000, null, 3000])).growthPerReply).toBeNull();
    for (const change of ['provider', 'resolved-model', 'window'] as const) {
      const c = chat([1000, 2000, 3000]);
      if (change === 'provider') c.messages[1].settings = { ...settings, provider: 'gemini' };
      if (change === 'resolved-model') c.messages[1].usage!.model = 'different-model';
      if (change === 'window') c.messages[1].usage!.contextWindow = 200000;
      expect(health(c).growthPerReply).toBeNull();
    }
  });
  it('keeps draft forecasts separate from measured status and preserves pending-reply trends', () => {
    const c = chat([20000, 30000, 40000]);
    const initial = health(c);
    c.messages.push({
      ...c.messages.at(-1)!,
      id: crypto.randomUUID(),
      status: 'running',
      usage: undefined,
    });
    expect(health(c)).toEqual(initial);
    const context = contextFor(c, settings, 'a'.repeat(410000), {
      ...automaticModel,
      contextWindow: 100000,
    });
    expect(contextPace(c, settings, context)).toEqual(initial);
    expect(forecastWarning(context)).toMatchObject({
      label: 'Estimate exceeds window',
      tone: 'danger',
    });
    expect(forecastWarning(contextFor(c, settings, '', automaticModel))).toBeNull();
  });
});
