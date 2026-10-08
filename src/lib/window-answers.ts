// Whether the desktop app still answers this window. On 2026-10-08 every call from the page went
// unanswered for an hour while replies ran on in the app: saves, sends, the window's own buttons.
// The page then only looked alive. These checks show it at once, and keep a record of the calls
// left waiting for docs/DIAGNOSTICS.md (src-tauri/src/watchdog.rs keeps the app's own).
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type Waiting = { command: string; since: number };
const waiting = new Set<Waiting>();

/** Tauri's `invoke`, given exactly its arguments, remembering each call until it is answered. */
export function invoke<T>(...request: Parameters<typeof tauriInvoke>): Promise<T> {
  const call = { command: request[0], since: Date.now() };
  waiting.add(call);
  const done = () => void waiting.delete(call);
  let answer: Promise<T>;
  try {
    answer = Promise.resolve(tauriInvoke<T>(...request));
  } catch (error) {
    done();
    throw error;
  }
  answer.then(done, done);
  return answer;
}

export type WaitingCall = { command: string; waitedMs: number };

/** The calls the app has not answered yet, longest waiting first. */
export function waitingCalls(now = Date.now(), limit = 50): WaitingCall[] {
  return [...waiting]
    .sort((a, b) => a.since - b.since)
    .slice(0, limit)
    .map(({ command, since }) => ({ command, waitedMs: Math.max(0, now - since) }));
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
