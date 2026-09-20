import { describe, expect, it, vi } from 'vitest';
import { createContextCache, type ContextSelection, type ContextSnapshot } from './context';

const selected: ContextSelection = {
  provider: 'claude',
  model: 'sonnet',
  connectionId: 'account-a',
};
const folder = { computerId: 'desktop', environmentId: 'windows', path: 'C:\\Project' };
const snapshot = (checkedAt: number): ContextSnapshot => ({
  provider: 'claude',
  model: 'sonnet',
  checkedAt,
  execution: 'Windows',
  folder: folder.path,
  profile: 'Fixture profile',
  entries: [],
  notes: [],
  truncated: false,
});

describe('context cache', () => {
  it('does not reuse pending or cached inventories after the shared source changes', async () => {
    let scope = 'account-a';
    let finish!: (value: ContextSnapshot) => void;
    const read = vi
      .fn<Parameters<typeof createContextCache>[0]>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(snapshot(2));
    const cache = createContextCache(read, () => scope);
    const previous = cache.refresh(selected, folder);
    await Promise.resolve();
    scope = 'account-b';
    expect(cache.peek(selected, folder)).toBeUndefined();
    await cache.refresh(selected, folder);
    finish(snapshot(1));
    await expect(previous).rejects.toThrow('Shared context changed');
    expect(cache.peek(selected, folder)?.checkedAt).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('keeps conversation inventories separate including temporary sources in the same project', async () => {
    const cache = createContextCache(async () => snapshot(1));
    const a = { ...selected, conversationId: 'chat-a' };
    const b = { ...selected, conversationId: 'chat-b' };
    await cache.refresh(a);
    expect(cache.peek(b)).toBeUndefined();
    expect(cache.peek(selected)).toBeUndefined();
    expect(cache.peek(a)).toBeDefined();
    expect(cache.peek({ ...a, forked: true })).toBeUndefined();
    await cache.refresh(a, folder);
    expect(cache.peek(b, folder)).toBeUndefined();
    expect(cache.peek({ ...b, forked: true }, folder)).toBeUndefined();
  });
  it('retains the previous result while refreshing, shares pending work, and preserves it on failure', async () => {
    const read = vi
      .fn<Parameters<typeof createContextCache>[0]>()
      .mockResolvedValueOnce(snapshot(1));
    const cache = createContextCache(read);
    await cache.refresh(selected, folder);
    let resolve!: (value: ContextSnapshot) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const refresh = cache.refresh(selected, folder);
    expect(cache.refresh(selected, folder)).toBe(refresh);
    expect(cache.peek(selected, folder)?.checkedAt).toBe(1);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    resolve(snapshot(2));
    await refresh;
    expect(cache.peek(selected, folder)?.checkedAt).toBe(2);
    read.mockRejectedValueOnce(new Error('Offline'));
    await expect(cache.refresh(selected, folder)).rejects.toThrow('Offline');
    expect(cache.peek(selected, folder)?.checkedAt).toBe(2);
    read.mockResolvedValueOnce(snapshot(3));
    await cache.refresh(selected, folder);
    expect(cache.peek(selected, folder)?.checkedAt).toBe(3);
  });

  it('partitions snapshots by provider, model, account, computer, environment, and folder', async () => {
    const cache = createContextCache(async () => snapshot(1));
    await cache.refresh(selected, folder);
    for (const change of [
      { provider: 'codex' as const },
      { model: 'opus' },
      { connectionId: 'account-b' },
    ]) {
      expect(cache.peek({ ...selected, ...change }, folder)).toBeUndefined();
    }
    for (const change of [
      { computerId: 'laptop' },
      { environmentId: 'wsl' },
      { executionEnvironmentId: 'other-execution' },
      { path: 'C:\\Other' },
    ]) {
      expect(cache.peek(selected, { ...folder, ...change })).toBeUndefined();
    }
    expect(cache.peek(selected)).toBeUndefined();
    expect(cache.peek({ ...selected }, { ...folder })?.checkedAt).toBe(1);
  });

  it('keeps out-of-order completions under their captured selection', async () => {
    let resolve!: (value: ContextSnapshot) => void;
    const read = vi
      .fn<Parameters<typeof createContextCache>[0]>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce({ ...snapshot(2), model: 'opus' });
    const cache = createContextCache(read);
    const original = { ...selected };
    const first = cache.refresh(original, folder);
    original.model = 'opus';
    await cache.refresh(original, folder);
    resolve(snapshot(1));
    await first;
    expect(read.mock.calls[0][0].model).toBe('sonnet');
    expect(cache.peek(selected, folder)?.model).toBe('sonnet');
    expect(cache.peek(original, folder)?.model).toBe('opus');
  });

  it('bounds session memory while retaining recently inspected selections', async () => {
    const cache = createContextCache(async () => snapshot(1));
    for (let i = 0; i < 32; i++)
      await cache.refresh({ ...selected, connectionId: String(i) }, folder);
    cache.peek({ ...selected, connectionId: '0' }, folder);
    await cache.refresh({ ...selected, connectionId: '32' }, folder);
    expect(cache.peek({ ...selected, connectionId: '0' }, folder)).toBeDefined();
    expect(cache.peek({ ...selected, connectionId: '1' }, folder)).toBeUndefined();
  });
});
