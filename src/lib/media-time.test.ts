import { expect, it } from 'vitest';
import { mediaTime, seekKey } from './media-time';

it('shows a place in a sound as minutes and seconds, with hours once it has them', () => {
  expect(mediaTime(0)).toBe('0:00');
  expect(mediaTime(42.9)).toBe('0:42');
  expect(mediaTime(195)).toBe('3:15');
  expect(mediaTime(3723)).toBe('1:02:03');
  expect(mediaTime(36_000)).toBe('10:00:00');
  // What a player can report before it knows.
  expect(mediaTime(Number.NaN)).toBe('0:00');
  expect(mediaTime(Infinity)).toBe('0:00');
  expect(mediaTime(-3)).toBe('0:00');
});

it('moves the position by the keys a slider takes, within the sound', () => {
  expect(seekKey('ArrowRight', 10, 60)).toBe(15);
  expect(seekKey('ArrowUp', 58, 60)).toBe(60);
  expect(seekKey('ArrowLeft', 3, 60)).toBe(0);
  expect(seekKey('PageUp', 10, 200)).toBe(30);
  expect(seekKey('PageDown', 10, 200)).toBe(0);
  expect(seekKey('Home', 42, 60)).toBe(0);
  expect(seekKey('End', 42, 60)).toBe(60);
  expect(seekKey('Enter', 42, 60)).toBeUndefined();
});
