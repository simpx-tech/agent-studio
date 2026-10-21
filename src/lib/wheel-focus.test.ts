import { expect, it } from 'vitest';
import { takesWheel } from './wheel-focus';

const wheel = (ctrlKey = false, cancelable = true) => ({ ctrlKey, cancelable });

it('a view in the chat takes the wheel only while the reader works with its card', () => {
  // Until a click on it, the wheel scrolls the chat; after one, it zooms the view.
  expect(takesWheel(wheel(), false)).toBe(false);
  expect(takesWheel(wheel(), true)).toBe(true);
  // A pinch, a wheel with Ctrl held, zooms the view under the fingers either way.
  expect(takesWheel(wheel(true), false)).toBe(true);
  // A wheel the browser already scrolled the chat with arrives uncancelable and stays the
  // chat's, even over a view the reader works with.
  expect(takesWheel(wheel(false, false), true)).toBe(false);
  expect(takesWheel(wheel(true, false), true)).toBe(false);
});
