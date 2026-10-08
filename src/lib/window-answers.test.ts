import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import {
  invoke,
  rememberStall,
  takeRememberedStall,
  waitingCalls,
  watchAnswers,
  type WindowStall,
} from './window-answers';

function watch(options: { shown?: () => boolean } = {}) {
  let tick = () => {};
  let clock = 0;
  const answers: { resolve: () => void }[] = [];
  const events: [string, number][] = [];
  const watcher = watchAnswers({
    check: () => new Promise<void>((resolve) => answers.push({ resolve })),
    stalled: (stall, waited) => events.push([stall ? 'stalled' : 'answered', waited]),
    shown: options.shown ?? (() => true),
    now: () => clock,
    repeat: (run) => {
      tick = run;
      return () => (tick = () => {});
    },
  });
  return {
    watcher,
    events,
    answers,
    tick: (ms = 5000) => {
      clock += ms;
      tick();
    },
  };
}

describe('window answers', () => {
  it('reports a stall once a check stays unanswered for four shown checks, and its end', async () => {
    const { events, answers, tick } = watch();
    expect(answers).toHaveLength(1);
    tick();
    tick();
    tick();
    expect(events).toEqual([]);
    tick();
    expect(events).toEqual([['stalled', 20_000]]);
    // One report per stall, however long it lasts.
    tick();
    tick();
    expect(events).toHaveLength(1);
    answers[0].resolve();
    await Promise.resolve();
    expect(events).toEqual([
      ['stalled', 20_000],
      ['answered', 30_000],
    ]);
    // Checks go on after an answer, one at a time.
    tick();
    expect(answers).toHaveLength(2);
    tick();
    expect(answers).toHaveLength(2);
  });

  it('owes nothing while hidden and counts only shown checks', async () => {
    let shown = false;
    const { events, answers, tick } = watch({ shown: () => shown });
    for (let i = 0; i < 100; i++) tick();
    expect(events).toEqual([]);
    shown = true;
    tick();
    tick();
    tick();
    expect(events).toEqual([]);
    tick();
    expect(events).toHaveLength(1);
    answers[0].resolve();
    await Promise.resolve();
    expect(events.at(-1)?.[0]).toBe('answered');
  });

  it('checks at once when asked, unless a check waits, and stops', async () => {
    const { watcher, answers, tick } = watch();
    watcher.check();
    expect(answers).toHaveLength(1);
    answers[0].resolve();
    await Promise.resolve();
    watcher.check();
    expect(answers).toHaveLength(2);
    watcher.stop();
    answers[1].resolve();
    await Promise.resolve();
    tick();
    expect(answers).toHaveLength(2);
  });

  it('remembers the calls the app has not answered, longest waiting first', async () => {
    let finish: (value: string) => void = () => {};
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    native.invoke.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    native.invoke.mockImplementationOnce(() => {
      throw new Error('no bridge');
    });
    const now = Date.now();
    const slow = invoke<string>('save_workspace_patch', { index: {} });
    await expect(invoke('relay_request')).rejects.toThrow('refused');
    expect(() => invoke('window_heartbeat')).toThrow('no bridge');
    const waiting = waitingCalls(now + 3000);
    expect(waiting).toEqual([{ command: 'save_workspace_patch', waitedMs: expect.any(Number) }]);
    expect(waiting[0].waitedMs).toBeGreaterThanOrEqual(2900);
    finish('saved');
    await expect(slow).resolves.toBe('saved');
    expect(waitingCalls()).toEqual([]);
  });

  it('keeps one stall record across a reload until it is taken', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => void values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
    };
    const stall: WindowStall = {
      noticedAt: 1,
      unansweredMs: 20_000,
      answeredAfterMs: null,
      calls: [{ command: 'save_workspace_patch', waitedMs: 7_200_000 }],
    };
    expect(takeRememberedStall(storage)).toBeUndefined();
    rememberStall(stall, storage);
    expect(takeRememberedStall(storage)).toEqual(stall);
    expect(takeRememberedStall(storage)).toBeUndefined();
    values.set('agent-studio.window-stall', '{"noticedAt":"soon"}');
    expect(takeRememberedStall(storage)).toBeUndefined();
    values.set('agent-studio.window-stall', 'not json');
    expect(takeRememberedStall(storage)).toBeUndefined();
  });
});
