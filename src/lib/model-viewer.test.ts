import { describe, expect, it, vi } from 'vitest';
import { createScenePlaces, sceneKey, type Place } from './model-viewer';
import type { ModelScene } from './model-scene';

/** A stage that is on or off screen since a given moment, releasing its scene when asked. */
function stage(onScreen: boolean, seenAt: number) {
  const state = { onScreen, seenAt, released: 0, woken: 0 };
  const place: Place = {
    onScreen: () => state.onScreen,
    seenAt: () => state.seenAt,
    release: vi.fn(() => state.released++),
    wake: vi.fn(() => state.woken++),
  };
  return { state, place };
}

/**
 * Browsers keep about sixteen WebGL contexts per page and drop the oldest past that, which
 * left models blank with no message once a chat showed enough of them. A window now holds a
 * bounded number of scenes and hands their places out in turn.
 */
describe('createScenePlaces', () => {
  it('gives a new scene the place of the one out of view longest', () => {
    const places = createScenePlaces(2);
    const left = stage(false, 10);
    const leftEarlier = stage(false, 5);
    expect(places.take(left.place)).toBe(true);
    expect(places.take(leftEarlier.place)).toBe(true);
    const next = stage(true, 20);
    expect(places.take(next.place)).toBe(true);
    expect(leftEarlier.state.released).toBe(1);
    expect(left.state.released).toBe(0);
    expect(places.held).toBe(2);
    // The released stage giving its place back afterwards changes nothing.
    places.give(leftEarlier.place);
    expect(places.held).toBe(2);
  });

  it('keeps every scene on screen, and wakes a waiting stage when a place frees', () => {
    const places = createScenePlaces(2);
    const [a, b] = [stage(true, 1), stage(true, 2)];
    places.take(a.place);
    places.take(b.place);
    const [late, later] = [stage(true, 3), stage(true, 4)];
    expect(places.take(late.place)).toBe(false);
    expect(places.take(later.place)).toBe(false);
    expect(a.state.released + b.state.released).toBe(0);
    places.give(a.place);
    // The stage that waited longest is woken, and takes the freed place.
    expect([late.state.woken, later.state.woken]).toEqual([1, 0]);
    expect(places.take(late.place)).toBe(true);
    // A stage that gives up waiting is not woken later.
    places.give(later.place);
    places.give(b.place);
    expect(later.state.woken).toBe(0);
    expect(places.held).toBe(1);
  });

  it('counts a place once however often it is taken', () => {
    const places = createScenePlaces(1);
    const one = stage(true, 1);
    expect(places.take(one.place)).toBe(true);
    expect(places.take(one.place)).toBe(true);
    expect(places.held).toBe(1);
    places.give(one.place);
    places.give(one.place);
    expect(places.held).toBe(0);
  });
});

/** What each key did to a scene, as the calls it made. */
function pressed(key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const scene = {
    orbit: record('orbit'),
    pan: record('pan'),
    zoom: record('zoom'),
    reset: record('reset'),
  } as unknown as ModelScene;
  const action = sceneKey({
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  });
  action?.(scene);
  return action ? calls : undefined;
}

describe('sceneKey', () => {
  it('turns with the arrows and moves the view with Shift and the arrows', () => {
    expect(pressed('ArrowRight')).toEqual([['orbit', 0.12, 0]]);
    expect(pressed('ArrowUp')).toEqual([['orbit', 0, 0.12]]);
    // The view moves the way the arrows move a zoomed image: right shows more of the right.
    expect(pressed('ArrowRight', { shiftKey: true })).toEqual([['pan', 0.1, 0]]);
    expect(pressed('ArrowLeft', { shiftKey: true })).toEqual([['pan', -0.1, 0]]);
    expect(pressed('ArrowUp', { shiftKey: true })).toEqual([['pan', 0, 0.1]]);
    expect(pressed('ArrowDown', { shiftKey: true })).toEqual([['pan', 0, -0.1]]);
  });

  it('zooms with + and -, resets with Home, and leaves other keys and shortcuts alone', () => {
    expect(pressed('+', { shiftKey: true })).toEqual([['zoom', 0.8]]);
    expect(pressed('-')).toEqual([['zoom', 1.25]]);
    expect(pressed('Home')).toEqual([['reset']]);
    expect(pressed('ArrowRight', { ctrlKey: true })).toBeUndefined();
    expect(pressed('a')).toBeUndefined();
  });
});
