import { describe, expect, it, vi } from 'vitest';
import { createScenePlaces, type Place } from './model-viewer';

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
