/**
 * Whether two values serialize to the same JSON, as `JSON.stringify(a) === JSON.stringify(b)`
 * tells, without writing either text. Copies of a conversation share the messages and calls that
 * did not change between them (src/lib/chat-snapshots.ts), and a part both copies share is equal
 * at once, so comparing two copies of a long conversation costs what differs between them. Two
 * such comparisons a poll, each writing megabytes of text twice, held the page for 180 ms of the
 * 430 ms a poll took in a 9.8 MB chat (docs/PERFORMANCE.md).
 *
 * Like the texts it stands for, it tells objects with their keys in another order apart, leaves
 * out keys without a value, and reads a missing array item and a number JSON cannot write as
 * `null`.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  // Alone, a value JSON cannot write serializes to nothing at all.
  if (unwritten(a) || unwritten(b)) return unwritten(a) && unwritten(b);
  return same(a, b);
}

/** What `JSON.stringify` leaves out of an object, and writes as `null` in an array. */
const unwritten = (value: unknown) =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

const customized = (value: object) => typeof (value as { toJSON?: unknown }).toJSON === 'function';

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    // Neither NaN nor an infinity has a JSON form: each is written as `null`.
    const x = typeof a === 'number' && !Number.isFinite(a) ? null : a;
    const y = typeof b === 'number' && !Number.isFinite(b) ? null : b;
    return x === y;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  // A value that writes itself, such as a date, is compared as it writes.
  if (customized(a) || customized(b)) return JSON.stringify(a) === JSON.stringify(b);
  const list = Array.isArray(a);
  if (list !== Array.isArray(b)) return false;
  if (list) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let index = 0; index < x.length; index++) {
      const left = x[index];
      const right = y[index];
      if (left === right) continue;
      if (!same(unwritten(left) ? null : left, unwritten(right) ? null : right)) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  const others = Object.keys(y);
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < keys.length && unwritten(x[keys[i]])) i++;
    while (j < others.length && unwritten(y[others[j]])) j++;
    if (i === keys.length || j === others.length) return i === keys.length && j === others.length;
    if (keys[i] !== others[j] || !same(x[keys[i]], y[others[j]])) return false;
    i++;
    j++;
  }
}
