import { expect, it } from 'vitest';
import { carriesOnScroll, SCROLL_PAUSE_MS } from './wheel-latch';

const wheel = (
  timeStamp: number,
  clientX = 200,
  clientY = 120,
  ctrlKey = false,
  cancelable = true,
) => ({
  timeStamp,
  clientX,
  clientY,
  ctrlKey,
  cancelable,
});
const scroll = { at: 1000, x: 200, y: 120 };

it('a wheel over a view zooms it unless it carries on a scroll of the conversation', () => {
  // With no scroll before it, the view takes the wheel.
  expect(carriesOnScroll(wheel(1000), undefined)).toBe(false);
  // A scroll that brought the view under a still pointer carries on while it does not pause.
  expect(carriesOnScroll(wheel(1080), scroll)).toBe(true);
  expect(carriesOnScroll(wheel(1000 + SCROLL_PAUSE_MS - 1, 203, 121), scroll)).toBe(true);
  // A pause ends it, and so does the pointer moving to aim at the view.
  expect(carriesOnScroll(wheel(1000 + SCROLL_PAUSE_MS), scroll)).toBe(false);
  expect(carriesOnScroll(wheel(1080, 210, 120), scroll)).toBe(false);
  // A pinch, a wheel with Ctrl held, always zooms.
  expect(carriesOnScroll(wheel(1080, 200, 120, true), scroll)).toBe(false);
  // A wheel the browser already scrolled the page with arrives uncancelable, and belongs to the
  // scroll however it reached the view.
  expect(carriesOnScroll(wheel(1000, 200, 120, false, false), undefined)).toBe(true);
  expect(carriesOnScroll(wheel(5000, 400, 300, true, false), scroll)).toBe(true);
});
