import { describe, expect, it } from 'vitest';
import { contextPace, forecastWarning, quotaPace } from './pace';
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
