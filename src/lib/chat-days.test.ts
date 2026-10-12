import { describe, expect, it } from 'vitest';
import { chatDays } from './chat-days';

// Local times, as the reader's clock shows them.
const now = new Date(2026, 9, 12, 15, 30).getTime();
const at = (day: number, hour = 9, minute = 0, month = 9, year = 2026) =>
  new Date(year, month, day, hour, minute).toISOString();
const chat = (...times: string[]) => times.map((createdAt, i) => ({ id: `m${i}`, createdAt }));
const full = (day: number, month = 9, year = 2026) =>
  new Date(year, month, day).toLocaleDateString([], { dateStyle: 'full' });
const names = (messages: { id: string; createdAt: string }[], from = now) =>
  [...chatDays(messages, from)].map(([id, day]) => [id, day.name]);

describe('chat days', () => {
  it('leaves a chat from today undivided', () => {
    expect(chatDays(chat(at(12, 0, 0), at(12, 9), at(12, 23, 59)), now).size).toBe(0);
    expect(chatDays([], now).size).toBe(0);
  });

  it('opens a chat from another day with its day', () => {
    expect([...chatDays(chat(at(11, 22), at(11, 22, 5)), now)]).toEqual([
      ['m0', { name: 'Yesterday', date: full(11) }],
    ]);
  });

  it('divides a chat where it continues on another day', () => {
    const messages = chat(at(11, 22), at(11, 23, 59), at(12, 0, 0), at(12, 9));
    expect([...chatDays(messages, now)]).toEqual([
      ['m0', { name: 'Yesterday', date: full(11) }],
      ['m2', { name: 'Today', date: full(12) }],
    ]);
  });

  it('names each day from today', () => {
    const messages = chat(at(30, 9, 0, 11, 2025), at(1), at(8), at(8, 10), at(11), at(12));
    expect(names(messages)).toEqual([
      [
        'm0',
        new Date(2025, 11, 30).toLocaleDateString([], {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      ],
      [
        'm1',
        new Date(2026, 9, 1).toLocaleDateString([], {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }),
      ],
      ['m2', new Date(2026, 9, 8).toLocaleDateString([], { weekday: 'long' })],
      ['m4', 'Yesterday'],
      ['m5', 'Today'],
    ]);
  });

  it('follows today as it moves on', () => {
    const messages = chat(at(12, 23, 50), at(12, 23, 58));
    expect(names(messages, new Date(2026, 9, 12, 23, 59).getTime())).toEqual([]);
    // After midnight the open chat is from yesterday, and a message sent then starts today.
    const midnight = new Date(2026, 9, 13).getTime();
    expect(names(messages, midnight)).toEqual([['m0', 'Yesterday']]);
    expect(names([...messages, { id: 'next', createdAt: at(13, 0, 1) }], midnight)).toEqual([
      ['m0', 'Yesterday'],
      ['next', 'Today'],
    ]);
  });

  it('skips messages without a readable time', () => {
    const messages = [
      { id: 'unknown', createdAt: '' },
      ...chat(at(11), at(11, 10)),
      { id: 'broken', createdAt: 'not a time' },
      { id: 'last', createdAt: at(11, 12) },
    ];
    expect(names(messages)).toEqual([['m0', 'Yesterday']]);
  });

  it('names a day again when a clock set differently puts a message before it', () => {
    expect(names(chat(at(12), at(11, 23), at(12, 9, 5)))).toEqual([
      ['m1', 'Yesterday'],
      ['m2', 'Today'],
    ]);
  });
});
