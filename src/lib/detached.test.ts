import { describe, expect, it } from 'vitest';
// What `$state` compiles to: the page's workspace is one of these proxies.
import { proxy } from 'svelte/internal/client';
import { detached, liveField } from './detached';

type Chat = {
  title: string;
  settings?: { model: string };
  messages: { id: string; blocks: { type: string; text: string }[] }[];
};
const saved = (): Chat => ({
  title: 'Chat',
  settings: { model: 'opus' },
  messages: [{ id: 'a', blocks: [{ type: 'markdown', text: 'Hi' }] }],
});

describe('detached copies', () => {
  it('copy Svelte state without making any of it reactive', () => {
    const target = saved();
    const live = proxy(target);
    const copy = detached(live);
    expect(copy).toEqual(saved());
    expect(copy).not.toBe(target);
    expect(copy.messages[0]).not.toBe(target.messages[0]);
    // Svelte gives a field a signal, and wraps its value, only when the field is read through
    // its proxy: every field still holds what was saved, so nothing was.
    for (const key of Object.keys(target) as (keyof Chat)[])
      expect(liveField(live, key)).toBe(target[key]);
  });

  it('copy what changed through the proxies, as a snapshot does', () => {
    const live = proxy(saved());
    // The window reads and changes the state as the page does.
    live.messages[0].blocks.push({ type: 'markdown', text: 'More' });
    live.title = 'Renamed';
    delete live.settings;
    live.messages.push({ id: 'b', blocks: [] });
    const copy = detached(live);
    expect(copy).toEqual({
      title: 'Renamed',
      messages: [
        {
          id: 'a',
          blocks: [
            { type: 'markdown', text: 'Hi' },
            { type: 'markdown', text: 'More' },
          ],
        },
        { id: 'b', blocks: [] },
      ],
    });
    expect('settings' in copy).toBe(false);
    live.messages.length = 1;
    expect(detached(live).messages).toHaveLength(1);
    expect(liveField(live, 'settings')).toBeUndefined();
  });

  it('copy plain data and leave other objects as they are', () => {
    const when = new Date(0);
    const value = { when, list: [1, 'two', null, { three: 3 }] };
    const copy = detached(value);
    expect(copy).toEqual(value);
    expect(copy.list).not.toBe(value.list);
    expect(copy.when).toBe(when);
  });
});
