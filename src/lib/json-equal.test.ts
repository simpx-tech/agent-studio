import { describe, expect, it } from 'vitest';
import { jsonEqual } from './json-equal';

const texts = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A small generator with a fixed seed, so a failure repeats.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const leaves = [
  0,
  -0,
  1,
  1.5,
  -3,
  NaN,
  Infinity,
  -Infinity,
  '',
  'a',
  'null',
  '1',
  'line\nbreak "quoted" \u2028',
  '\ud800',
  true,
  false,
  null,
  undefined,
  () => 1,
  Symbol.for('s'),
];

function value(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth <= 0 || roll < 0.45) return leaves[Math.floor(next() * leaves.length)];
  if (roll < 0.7)
    return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth - 1));
  const keys = ['a', 'b', 'c', '1', '2', 'key'].filter(() => next() < 0.5);
  if (next() < 0.3) keys.reverse();
  return Object.fromEntries(keys.map((key) => [key, value(next, depth - 1)]));
}

/** A copy that shares none of its parts, changed in one place now and then. */
function varied(source: unknown, next: () => number): unknown {
  if (next() < 0.06) return leaves[Math.floor(next() * leaves.length)];
  if (Array.isArray(source)) return source.map((item) => varied(item, next));
  if (source && typeof source === 'object') {
    const entries = Object.entries(source).map(([key, item]) => [key, varied(item, next)]);
    if (next() < 0.05) entries.reverse();
    return Object.fromEntries(entries);
  }
  return source;
}

describe('jsonEqual', () => {
  it('agrees with comparing the JSON texts of unrelated values', () => {
    const next = random(1);
    for (let round = 0; round < 4000; round++) {
      const a = value(next, 4);
      const b = value(next, 4);
      expect(jsonEqual(a, b), JSON.stringify([a, b])).toBe(texts(a, b));
    }
  });

  it('agrees with comparing the JSON texts of a value and its near copies', () => {
    const next = random(2);
    let equal = 0;
    for (let round = 0; round < 4000; round++) {
      const a = value(next, 5);
      const b = varied(a, next);
      if (texts(a, b)) equal++;
      expect(jsonEqual(a, b), JSON.stringify([a, b])).toBe(texts(a, b));
      expect(jsonEqual(b, a)).toBe(texts(b, a));
    }
    // Both outcomes are well covered.
    expect(equal).toBeGreaterThan(400);
    expect(equal).toBeLessThan(3600);
  });

  it('reads what JSON cannot write as JSON does', () => {
    expect(jsonEqual(undefined, undefined)).toBe(true);
    expect(jsonEqual(undefined, null)).toBe(false);
    expect(jsonEqual(NaN, null)).toBe(true);
    expect(jsonEqual([undefined], [null])).toBe(true);
    expect(jsonEqual({ a: undefined }, {})).toBe(true);
    expect(jsonEqual({ a: 1, b: undefined, c: 2 }, { a: 1, c: 2 })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual(new Date(5), new Date(5))).toBe(true);
    expect(jsonEqual(new Date(5), new Date(6))).toBe(false);
  });

  it('takes a part both values share as equal without reading it', () => {
    let reads = 0;
    const shared = new Proxy(
      { text: 'x'.repeat(10) },
      {
        ownKeys(target) {
          reads++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const a = { id: 1, messages: [shared, { text: 'a' }] };
    const b = { id: 1, messages: [shared, { text: 'a' }] };
    expect(jsonEqual(a, b)).toBe(true);
    expect(reads).toBe(0);
    expect(jsonEqual(a, { id: 1, messages: [shared, { text: 'b' }] })).toBe(false);
    expect(reads).toBe(0);
  });
});
