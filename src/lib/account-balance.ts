import type { Conversation, ProviderId } from './domain';
import type { Fleet } from './fleet';
import { resetTime, visibleLimits, type UsageSnapshot } from './usage';

// Balancing new chats between accounts (Settings → New chats, off unless turned on): a new chat
// starts on the account of its agent, on its computer, that has used the least, so several
// accounts are used evenly instead of one until its limit. Accounts with room on their 5-hour
// limit compare by the share used of their weekly limit, which takes a week to come back where
// the 5-hour one returns within hours.

/**
 * Accounts whose usage differs by no more than this many percentage points count as level, as
 * a limit within 5 points of its even-use guide counts as on track. Level accounts take turns,
 * so chats started together spread over them before their readings show any of it.
 */
export const levelPoints = 5;

/**
 * The share of its 5-hour limit, in percent, from which an account is nearly out of it: the rest
 * is left to the replies already running there, and new chats start on accounts with more room
 * while there are any.
 */
export const nearlyFull = 80;

export type BalanceCandidate = {
  connectionId: string;
  /** The account's latest usage reading, when it has one. */
  snapshot?: UsageSnapshot;
  /** Replies running on the account now, whose usage its reading does not show yet. */
  running: number;
  /** When a reply last started on the account, in milliseconds, or 0 when none did. */
  lastUsed: number;
};

type Standing = BalanceCandidate & {
  order: number;
  /**
   * 0 has room, 1 is nearly out of its 5-hour limit, 2 reports no usage to compare, 3 has used a
   * limit up.
   */
  group: 0 | 1 | 2 | 3;
  /**
   * The share accounts compare by: of the weekly limit, or of the 5-hour one when nearly out of it
   * or without a weekly limit.
   */
  used: number;
  /** The share of the other limit, which decides between level accounts. */
  other: number;
  /** When a limit that is used up begins again. */
  resumes: number;
};

function standing(
  candidate: BalanceCandidate,
  order: number,
  chat: { provider: ProviderId; model: string },
  now: number,
): Standing {
  // The limits the chat's own usage bars show for this account and model.
  const limits = visibleLimits(candidate.snapshot, {
    provider: chat.provider,
    model: chat.model,
    reasoning: '',
    instructions: '',
  }).map((window) => {
    const reset = resetTime(window.resetsAt);
    // A window that ended since its reading began again empty.
    const used =
      window.usedPercent == null ? null : reset != null && reset <= now ? 0 : window.usedPercent;
    return { minutes: window.windowMinutes, used, reset };
  });
  const fiveHour = limits.find((limit) => limit.minutes === 300)?.used ?? null;
  // The weekly limit the chat would run out of first: a Claude Fable chat also has Fable's own.
  const weeks = limits.flatMap((limit) =>
    limit.minutes === 10080 && limit.used != null ? [limit.used] : [],
  );
  const weekly = weeks.length ? Math.max(...weeks) : null;
  const spent = limits.filter((limit) => limit.used != null && limit.used >= 100);
  // Claude also says so itself when it refuses a reply over an account-wide limit.
  const refused = candidate.snapshot?.live?.limitStatus;
  const refusedUntil =
    refused?.status === 'rejected' &&
    (refused.limitType === 'five_hour' || refused.limitType === 'seven_day') &&
    refused.resetsAt != null &&
    refused.resetsAt * 1000 > now
      ? refused.resetsAt * 1000
      : null;
  const nearlyOut = fiveHour != null && fiveHour >= nearlyFull;
  // An account compares by its weekly limit while it has room on its 5-hour one, and by the
  // 5-hour limit once nearly out of it or when it reports no weekly limit.
  const byFiveHour = nearlyOut || weekly == null;
  const used = byFiveHour ? fiveHour : weekly;
  return {
    ...candidate,
    order,
    group: spent.length || refusedUntil != null ? 3 : nearlyOut ? 1 : used == null ? 2 : 0,
    used: used ?? Infinity,
    other: (byFiveHour ? weekly : fiveHour) ?? Infinity,
    resumes: Math.max(refusedUntil ?? 0, ...spent.map((limit) => limit.reset ?? Infinity)),
  };
}

/** The first of `standings` by each of `keys` in turn, lower first. */
function first(standings: Standing[], ...keys: ((standing: Standing) => number)[]) {
  return [...standings].sort((a, b) => {
    for (const key of keys) {
      const difference = key(a) - key(b);
      // Two unknowns (both infinite) are equal, not incomparable.
      if (difference && !Number.isNaN(difference)) return difference;
    }
    return a.order - b.order;
  })[0];
}

/**
 * The account a new chat starts on, of those its agent has on its computer (`candidates`, in the
 * order the Agent picker lists them). Accounts with room come first, compared by their weekly
 * limit, then those nearly out of their 5-hour limit, compared by it, then those without a
 * reading, then those with a limit used up. Accounts within `levelPoints` of the least used of
 * their group are level, and the chat goes to the one with the fewest replies running, then the
 * lowest usage of the other limit, then the one used longest ago.
 *
 * Given the account the chat already has (`current`), it keeps that one while no other account
 * is better by more than the tolerance, so a chosen account does not move with every reading.
 */
export function balancedAccount(
  candidates: readonly BalanceCandidate[],
  chat: { provider: ProviderId; model: string },
  now: number,
  current?: string,
): string | undefined {
  if (!candidates.length) return undefined;
  const standings = candidates.map((candidate, order) => standing(candidate, order, chat, now));
  const group = Math.min(...standings.map((s) => s.group));
  const best = standings.filter((s) => s.group === group);
  const lowest = Math.min(...best.map((s) => s.used));
  const level = group < 2 ? best.filter((s) => s.used <= lowest + levelPoints) : best;
  if (current !== undefined && level.some((s) => s.connectionId === current)) return current;
  return (
    group === 3
      ? first(level, (s) => s.resumes)
      : first(
          level,
          (s) => s.running,
          (s) => s.other,
          (s) => s.lastUsed,
        )
  ).connectionId;
}

/**
 * The accounts new chats can be balanced between, which Settings lets the user leave out one by
 * one: those connected beside another account of their agent on some computer, in the
 * workspace's order, each with the environments where it has that company.
 */
export function balanceableAccounts(fleet: Pick<Fleet, 'accounts' | 'connections'>) {
  const agent = new Map(fleet.accounts.map((account) => [account.id, account.provider]));
  // The accounts each environment has of each agent.
  const together = new Map<string, { environmentId: string; accounts: Set<string> }>();
  for (const { environmentId, accountId } of fleet.connections) {
    const provider = agent.get(accountId);
    if (!provider) continue;
    const key = `${environmentId} ${provider}`;
    if (!together.has(key)) together.set(key, { environmentId, accounts: new Set() });
    together.get(key)!.accounts.add(accountId);
  }
  const where = new Map<string, string[]>();
  for (const { environmentId, accounts } of together.values()) {
    if (accounts.size < 2) continue;
    for (const account of accounts)
      where.set(account, [...(where.get(account) ?? []), environmentId]);
  }
  return fleet.accounts.flatMap((account) => {
    const environmentIds = where.get(account.id);
    return environmentIds ? [{ ...account, environmentIds }] : [];
  });
}

/**
 * What the saved chats say about each account, by account: the replies running on it now and
 * when a reply last started on it. Each chat counts for the account that answered it last.
 */
export function accountActivity(
  conversations: readonly Pick<Conversation, 'messages'>[],
  accountOf: (connectionId: string) => string | undefined,
) {
  const activity = new Map<string, { running: number; lastUsed: number }>();
  for (const { messages } of conversations) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      const account =
        message.role === 'assistant' && message.settings?.connectionId
          ? accountOf(message.settings.connectionId)
          : undefined;
      if (!account) continue;
      const entry = activity.get(account) ?? { running: 0, lastUsed: 0 };
      if (message.status === 'running') entry.running++;
      const started = Date.parse(message.createdAt);
      if (started > entry.lastUsed) entry.lastUsed = started;
      activity.set(account, entry);
      break;
    }
  }
  return activity;
}
