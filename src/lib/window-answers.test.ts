import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import {
  answerBytes,
  callHeader,
  invoke,
  rememberStall,
  takeRememberedStall,
  waitingCalls,
  watchAnswers,
  watchIpcFallback,
  type IpcFallback,
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

  it('names each call in a header that a postMessage copy of it keeps', async () => {
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(null);
    const image = new Uint8Array([1, 2, 3]);
    await invoke('store_chat_image', image);
    await invoke('run_agent', { request: {} }, { headers: { 'X-Kept': 'yes' } });
    await invoke('relay_resume');
    const [first, second, third] = native.invoke.mock.calls;
    expect(first.slice(0, 2)).toEqual(['store_chat_image', image]);
    expect(second.slice(0, 2)).toEqual(['run_agent', { request: {} }]);
    expect(second[2].headers['x-kept']).toBe('yes');
    const names = [first, second, third].map((call) => call[2].headers[callHeader]);
    for (const name of names) expect(name).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(names).size).toBe(3);
    // Tauri's postMessage path sends options as JSON, which keeps only a plain object's headers.
    expect(JSON.parse(JSON.stringify(first[2])).headers[callHeader]).toBe(names[0]);
  });

  it('notices once when Tauri moves calls to postMessage, with the calls then waiting', async () => {
    vi.useFakeTimers();
    try {
      native.invoke.mockReset();
      native.invoke.mockImplementation(() => new Promise(() => {}));
      void invoke('run_agent', { request: {} });
      const logged: unknown[][] = [];
      const target = { warn: (...args: unknown[]) => void logged.push(args) };
      const original = target.warn;
      const noticed: IpcFallback[] = [];
      const stop = watchIpcFallback((fallback) => noticed.push(fallback), target);
      target.warn('something else');
      const failure = new TypeError('Failed to fetch');
      target.warn(
        'IPC custom protocol failed, Tauri will now use the postMessage interface instead',
        failure,
      );
      target.warn(
        'IPC custom protocol failed, Tauri will now use the postMessage interface instead',
      );
      // Every warning still reaches the console, and the record follows Tauri's move.
      expect(logged).toHaveLength(3);
      expect(noticed).toEqual([]);
      vi.runAllTimers();
      expect(noticed).toEqual([
        {
          noticedAt: expect.any(Number),
          error: 'TypeError: Failed to fetch',
          calls: [{ command: 'run_agent', waitedMs: expect.any(Number) }],
        },
      ]);
      stop();
      expect(target.warn).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads bytes answered raw, or as the numbers a postMessage answer carries', () => {
    const raw = new Uint8Array([137, 80, 78, 71]);
    expect(answerBytes(raw.buffer)).toBe(raw.buffer);
    expect([...new Uint8Array(answerBytes([137, 80, 78, 71]))]).toEqual([...raw]);
    const view = new Uint8Array([0, 137, 80, 0]).subarray(1, 3);
    expect([...new Uint8Array(answerBytes(view))]).toEqual([137, 80]);
    expect(() => answerBytes('PNG')).toThrow('The app answered without the file.');
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
