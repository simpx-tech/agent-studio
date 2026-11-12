import { describe, expect, it } from 'vitest';
import { shownLimits } from './shown-limits';

const storageKey = 'agent-studio.shown-limits';

// A device's storage, counting its writes.
function deviceStorage(saved?: string) {
  const items = new Map<string, string>(saved === undefined ? [] : [[storageKey, saved]]);
  let writes = 0;
  return {
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes++;
        items.set(key, value);
      },
    },
    saved: () => JSON.parse(items.get(storageKey) ?? 'null'),
    writes: () => writes,
  };
}

describe('the kinds of limit each account showed on this device', () => {
  it('expects an account’s own, else what its agent’s other accounts showed', () => {
    const device = deviceStorage();
    const shown = shownLimits(() => device.storage);
    expect(shown.expected('claude', 'one')).toBeUndefined();
    shown.remember('claude', 'one', ['fable-weekly', 'weekly']);
    expect(shown.expected('claude', 'one')).toEqual(['weekly', 'fable-weekly']);
    expect(shown.expected('codex', 'one')).toBeUndefined();
    // An account not read here yet takes after the agent's others, not another agent's.
    expect(shown.expected('claude', 'two')).toEqual(['weekly', 'fable-weekly']);
    expect(shown.expected('codex', 'three')).toBeUndefined();
    shown.remember('claude', 'two', ['five-hour', 'weekly']);
    expect(shown.expected('claude', 'new')).toEqual(['five-hour', 'weekly', 'fable-weekly']);
    // An account whose bars showed none expects none.
    shown.remember('codex', 'three', []);
    expect(shown.expected('codex', 'three')).toEqual([]);
    // The next start of the app reads what this one saved.
    expect(shownLimits(() => device.storage).expected('claude', 'one')).toEqual([
      'weekly',
      'fable-weekly',
    ]);
  });

  it('writes only changes, and forgets connections the workspace no longer holds', () => {
    const device = deviceStorage();
    const shown = shownLimits(() => device.storage);
    shown.remember('claude', 'one', ['weekly']);
    shown.remember('claude', 'two', ['weekly']);
    shown.remember('claude', 'one', ['weekly'], new Set(['one', 'two']));
    expect(device.writes()).toBe(2);
    shown.remember('claude', 'one', ['weekly'], new Set(['one']));
    expect(device.writes()).toBe(3);
    expect(device.saved()).toEqual({ one: { provider: 'claude', limits: ['weekly'] } });
  });

  it('ignores what it cannot read and keeps going without storage', () => {
    const odd = deviceStorage(
      JSON.stringify({
        one: { provider: 'claude', limits: ['weekly', 'daily'] },
        two: { provider: 'other', limits: [] },
        three: 5,
      }),
    );
    const shown = shownLimits(() => odd.storage);
    expect(shown.expected('claude', 'one')).toEqual(['weekly']);
    expect(shown.expected('codex', 'two')).toBeUndefined();
    expect(shownLimits(() => deviceStorage('{').storage).expected('claude', 'one')).toBeUndefined();
    const denied = shownLimits(() => ({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    }));
    denied.remember('claude', 'one', ['weekly']);
    expect(denied.expected('claude', 'one')).toEqual(['weekly']);
    const none = shownLimits(() => undefined);
    none.remember('codex', 'one', ['weekly']);
    expect(none.expected('codex', 'one')).toEqual(['weekly']);
  });
});
