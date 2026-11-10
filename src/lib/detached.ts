/**
 * Reading the page's state without making it reactive.
 *
 * The page holds its workspace as deep `$state`. Reading a field through one of its proxies gives
 * the field a signal and wraps the value in a proxy of its own, with a handler, a map of signals
 * and a signal for its version, all kept as long as the workspace is. Reading every conversation
 * that way to copy, save or sync it made the whole workspace reactive: on 2026-11-10 a 399 MB
 * workspace kept 2 GB of proxies and signals beside its data, the page reached the 4 GB its
 * JavaScript can hold, and the window crashed several times a day (docs/PERFORMANCE.md).
 *
 * A proxy's property descriptor holds the same current value, its signal's where it has one and
 * otherwise the value as it was saved, and listing its keys gives the keys it now has, without
 * Svelte making anything. Code that reads the whole workspace, or a whole conversation, reads it
 * through these.
 */

/**
 * A field's current value. A field deleted through a proxy keeps Svelte's marker for an absent
 * value in its descriptor, a symbol, which saved data never holds.
 */
export function liveField(object: object, key: PropertyKey): unknown {
  const value = Object.getOwnPropertyDescriptor(object, key)?.value;
  return typeof value === 'symbol' ? undefined : value;
}

/** A plain copy of live data, as `$state.snapshot` makes one, without making any of it reactive. */
export function detached<T>(value: T): T {
  return copy(value) as T;
}

function copy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const length = liveField(value, 'length') as number;
    const items = new Array<unknown>(length);
    for (let index = 0; index < length; index++) items[index] = copy(liveField(value, index));
    return items;
  }
  // Only plain objects are data: Svelte wraps nothing else either.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(value)) fields[key] = copy(liveField(value, key));
  return fields;
}
