import { expect, it } from 'vitest';
import { swipeClaims, swipeProgress, swipeSettles, type DrawerSwipe } from './drawerSwipe';

function swipe(open: boolean, x: number, y = 0, time = 0, width = 300): DrawerSwipe {
  const start = { x: open ? 160 : 8, y: 400 };
  return {
    width,
    open,
    ...start,
    at: { x, y: start.y + y, time },
    from: { x: start.x, time: 0 },
  };
}

it('follows the finger between the closed and open drawer', () => {
  expect(swipeProgress(swipe(false, 8))).toBe(0);
  expect(swipeProgress(swipe(false, 158))).toBeCloseTo(0.5);
  expect(swipeProgress(swipe(false, 500))).toBe(1);
  // A swipe back across an open drawer starts fully open and gives it back.
  expect(swipeProgress(swipe(true, 160))).toBe(1);
  expect(swipeProgress(swipe(true, 100))).toBeCloseTo(0.8);
  expect(swipeProgress(swipe(true, -200))).toBe(0);
});

it('claims a horizontal drag in its own direction and leaves other touches alone', () => {
  // Nothing is decided inside the direction lock.
  expect(swipeClaims(swipe(false, 14, 4))).toBe(undefined);
  expect(swipeClaims(swipe(false, 30))).toBe(true);
  // The closed drawer ignores a leftward drag, and the open one a rightward drag.
  expect(swipeClaims(swipe(false, -20))).toBe(false);
  expect(swipeClaims(swipe(true, 100))).toBe(true);
  expect(swipeClaims(swipe(true, 200))).toBe(false);
  // A mostly vertical drag scrolls the list it started in.
  expect(swipeClaims(swipe(false, 30, 40))).toBe(false);
  expect(swipeClaims(swipe(true, 100, -80))).toBe(false);
  expect(swipeClaims(swipe(false, 8, 30))).toBe(false);
});

it('settles on the travelled distance when the finger moves slowly', () => {
  const slow = (state: DrawerSwipe) =>
    swipeSettles({ ...state, at: { ...state.at, time: 900 } }, 900);
  expect(slow(swipe(false, 100))).toBe(false);
  expect(slow(swipe(false, 130))).toBe(true);
  // An open drawer keeps most of its width, so a short drag returns it.
  expect(slow(swipe(true, 100))).toBe(true);
  expect(slow(swipe(true, 20))).toBe(false);
});

it('settles a quick flick whatever distance it covered, until the finger stops', () => {
  expect(swipeSettles(swipe(false, 40, 0, 40), 45)).toBe(true);
  expect(swipeSettles({ ...swipe(true, 120, 0, 40), from: { x: 160, time: 0 } }, 45)).toBe(false);
  // A flick back closes what a long drag had nearly opened, while holding the
  // drawer still before lifting leaves the travelled distance to decide.
  const held = { ...swipe(false, 200, 0, 900), from: { x: 260, time: 880 } };
  expect(swipeSettles(held, 905)).toBe(false);
  expect(swipeSettles(held, 1400)).toBe(true);
});
