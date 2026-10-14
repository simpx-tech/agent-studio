// Whether the desktop app still answers this window. On 2026-10-08 every call from the page went
// unanswered for an hour while replies ran on in the app: saves, sends, the window's own buttons.
// The page then only looked alive. These checks show it at once, and keep a record of the calls
// left waiting for docs/DIAGNOSTICS.md (src-tauri/src/watchdog.rs keeps the app's own).
import { invoke as tauriInvoke, type InvokeOptions } from '@tauri-apps/api/core';

type Waiting = { command: string; since: number };
const waiting = new Set<Waiting>();

/** The header each call is named in (src-tauri/src/calls.rs). */
export const callHeader = 'studio-call';

/**
 * Tauri's `invoke`, naming each call and remembering it until it is answered. When a call's
 * fetch fails on the way, Tauri sends it again through `postMessage`, with the same name, and the
 * app runs a command that acts only once per name: on 2026-10-11 the second copies of two
 * running replies' calls failed both replies.
 */
export function invoke<T>(...request: Parameters<typeof tauriInvoke>): Promise<T> {
  const [command, args, options] = request;
  const call = { command, since: Date.now() };
  waiting.add(call);
  const done = () => void waiting.delete(call);
  let answer: Promise<T>;
  try {
    answer = Promise.resolve(tauriInvoke<T>(command, args, named(options)));
  } catch (error) {
    done();
    throw error;
  }
  answer.then(done, done);
  return answer;
}

/** The call's options with its name. `postMessage` carries headers only as a plain object. */
function named(options?: InvokeOptions): InvokeOptions {
  const headers: Record<string, string> = {};
  new Headers(options?.headers).forEach((value, key) => (headers[key] = value));
  headers[callHeader] = crypto.randomUUID();
  return { ...options, headers };
}

/**
 * The bytes a command answered with: an ArrayBuffer, or the same bytes as an array of numbers
 * once Tauri has moved the page's calls to `postMessage`, which answers in JSON.
 */
export function answerBytes(answer: unknown): ArrayBuffer {
  if (answer instanceof ArrayBuffer) return answer;
  if (ArrayBuffer.isView(answer))
    return new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength).slice().buffer;
  if (Array.isArray(answer)) return Uint8Array.from(answer).buffer;
  throw new Error('The app answered without the file.');
}

export type WaitingCall = { command: string; waitedMs: number };

/** The calls the app has not answered yet, longest waiting first. */
export function waitingCalls(now = Date.now(), limit = 50): WaitingCall[] {
  return [...waiting]
    .sort((a, b) => a.since - b.since)
    .slice(0, limit)
    .map(({ command, since }) => ({ command, waitedMs: Math.max(0, now - since) }));
}

/** The moment Tauri moved this page's calls to `postMessage`, as the app's diagnostics keep it. */
export type IpcFallback = { noticedAt: number; error: string; calls: WaitingCall[] };

let postMessageCalls = false;
/**
 * Whether Tauri moved this page's calls to `postMessage`, which carries bytes as a JSON array of
 * numbers, four times their size: a call that carries megabytes then sends its plain arguments.
 */
export const callsUsePostMessage = () => postMessageCalls;

/**
 * Tells `noticed` once when Tauri moves this page's calls from its IPC protocol to `postMessage`,
 * after a call's fetch failed on the way, with the failure and the calls waiting then, which
 * Tauri sends again. Tauri says so only in this console warning.
 */
export function watchIpcFallback(
  noticed: (fallback: IpcFallback) => void,
  target: Pick<Console, 'warn'> = console,
): () => void {
  const warn = target.warn;
  let seen = false;
  const watching = (...args: unknown[]) => {
    if (!seen && typeof args[0] === 'string' && args[0].startsWith('IPC custom protocol failed')) {
      seen = true;
      postMessageCalls = true;
      const fallback = {
        noticedAt: Date.now(),
        error: String(args[1] ?? ''),
        calls: waitingCalls(),
      };
      // After Tauri has moved to postMessage, which it does right after this warning.
      setTimeout(() => noticed(fallback), 0);
    }
    warn.apply(target, args);
  };
  target.warn = watching;
  return () => {
    if (target.warn === watching) target.warn = warn;
  };
}

/** A time the app did not answer this window, as the native diagnostics keep it. */
export type WindowStall = {
  noticedAt: number;
  unansweredMs: number;
  answeredAfterMs: number | null;
  calls: WaitingCall[];
};

export type AnswerWatch = {
  /** Checks now, as when the page is shown again, unless a check is waiting. */
  check: () => void;
  stop: () => void;
};

/**
 * Asks the app every `every` ms whether it answers, with whether the page is shown. A check left
 * unanswered for `stallAfter` checks in a row while the page is shown is a stall: hidden pages run
 * their timers late, and a computer that slept answers as it wakes, so only shown time counts.
 */
export function watchAnswers(options: {
  check: (shown: boolean) => Promise<unknown>;
  /** A stall began, or ended (`undefined`) with the time its check waited. */
  stalled: (stall: { since: number } | undefined, waitedMs: number) => void;
  shown?: () => boolean;
  every?: number;
  stallAfter?: number;
  now?: () => number;
  repeat?: (run: () => void, ms: number) => () => void;
}): AnswerWatch {
  const shown = options.shown ?? (() => document.visibilityState === 'visible');
  const now = options.now ?? Date.now;
  const every = options.every ?? 5000;
  const stallAfter = options.stallAfter ?? 4;
  const repeat =
    options.repeat ??
    ((run: () => void, ms: number) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    });
  let stopped = false;
  let pending = false;
  let sentAt = 0;
  let missed = 0;
  let stall = false;
  const answered = () => {
    pending = false;
    missed = 0;
    if (stall && !stopped) {
      stall = false;
      options.stalled(undefined, now() - sentAt);
    }
  };
  const tick = () => {
    if (stopped) return;
    const visible = shown();
    if (pending) {
      if (!visible || stall) return;
      if (++missed >= stallAfter) {
        stall = true;
        options.stalled({ since: sentAt }, now() - sentAt);
      }
      return;
    }
    pending = true;
    missed = 0;
    sentAt = now();
    void options.check(visible).then(answered, answered);
  };
  const cancel = repeat(tick, every);
  tick();
  return {
    check: () => {
      if (!pending) tick();
    },
    stop: () => {
      stopped = true;
      cancel();
    },
  };
}

const stallKey = 'agent-studio.window-stall';

/** Keeps a stall's record in this page's storage, so it survives a reload or a killed app. */
export function rememberStall(
  stall: WindowStall,
  storage: Pick<Storage, 'setItem'> = localStorage,
) {
  try {
    storage.setItem(stallKey, JSON.stringify(stall));
  } catch {
    // Storage is full or unavailable: the app's own report remains.
  }
}

/** The stall record left by an earlier page, which it removes. */
export function takeRememberedStall(
  storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage,
): WindowStall | undefined {
  try {
    const saved = storage.getItem(stallKey);
    storage.removeItem(stallKey);
    const value = saved ? (JSON.parse(saved) as WindowStall) : undefined;
    return value &&
      Number.isSafeInteger(value.noticedAt) &&
      Number.isSafeInteger(value.unansweredMs) &&
      Array.isArray(value.calls)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
