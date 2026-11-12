import {
  providerIds,
  type ChatSettings,
  type Conversation,
  type Preferences,
  type ProviderId,
} from './domain';
import { computerViews, type Fleet } from './fleet';
import { guidePace, quotaPace, type QuotaPace } from './pace';
import {
  limitSlot,
  limitSlots,
  resetTime,
  visibleLimits,
  type LimitSlot,
  type UsageSnapshot,
} from './usage';

// Balancing new chats between accounts (Settings → New chats, off unless turned on): a new chat
// starts on the account of its agent, on its computer, that has the most room for it, so several
// accounts are used evenly instead of one until its limit. Accounts compare by the share left of
// their 5-hour limit, or of their weekly limit when they report no 5-hour one, divided between
// the replies running there and the new chat, since replies running together go on using up the
// same limit.

/**
 * Accounts whose room differs by no more than this many percentage points count as level, as a
 * limit within 5 points of its even-use guide counts as on track. Level accounts take turns, so
 * chats started together spread over them before their readings show any of it.
 */
export const levelPoints = 5;

export type BalanceCandidate = {
  connectionId: string;
  /** The account's latest usage reading, when it has one. */
  snapshot?: UsageSnapshot;
  /** Replies running on the account now, which go on using what is left of its limits. */
  running: number;
  /** When a reply last started on the account, in milliseconds, or 0 when none did. */
  lastUsed: number;
};

type Standing = BalanceCandidate & {
  order: number;
  /** 0 has room, 1 reports no usage to compare, 2 has used a limit up. */
  group: 0 | 1 | 2;
  /**
   * The share accounts compare by: what is left of the 5-hour limit, or of the weekly one without
   * it, for each of the replies running there and the new chat.
   */
  room: number;
  /** The share used of the weekly limit, which decides between level accounts. */
  weekly: number;
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
  const used = fiveHour ?? weekly;
  return {
    ...candidate,
    order,
    group: spent.length || refusedUntil != null ? 2 : used == null ? 1 : 0,
    // What is left is shared by the replies already running there and the new chat: with two
    // running on an account that used 30% of its 5-hour limit, the new chat has a third of the
    // 70% left there.
    room: used == null ? -Infinity : (100 - used) / (candidate.running + 1),
    weekly: weekly ?? Infinity,
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
 * order the Agent picker lists them). Accounts with room come first, then those without a
 * reading, then those with a limit used up. Among accounts with room, those within `levelPoints`
 * of the most room for the new chat are level, and the chat goes to the one with the fewest
 * replies running, then the lowest weekly usage, then the one used longest ago.
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
  const most = Math.max(...best.map((s) => s.room));
  const level = group === 0 ? best.filter((s) => s.room >= most - levelPoints) : best;
  if (current !== undefined && level.some((s) => s.connectionId === current)) return current;
  return (
    group === 2
      ? first(level, (s) => s.resumes)
      : first(
          level,
          (s) => s.running,
          (s) => s.weekly,
          (s) => s.lastUsed,
        )
  ).connectionId;
}

/**
 * Where new chats are balanced between accounts, which Settings lets the user narrow on each
 * computer: every computer with more than one account of an agent, agent by agent as the Agent
 * picker lists them, then computer by computer as Connections lists them (each WSL distribution
 * apart), each with its accounts' connections there in the workspace's order.
 */
export function balanceGroups(fleet: Fleet) {
  const agent = new Map(fleet.accounts.map((account) => [account.id, account.provider]));
  const places = computerViews(fleet).flatMap((view) => view.environments.map((e) => e.id));
  return providerIds.flatMap((provider) =>
    places.flatMap((environmentId) => {
      const connections = fleet.connections.filter(
        (c) => c.environmentId === environmentId && agent.get(c.accountId) === provider,
      );
      return connections.length > 1 ? [{ provider, environmentId, connections }] : [];
    }),
  );
}

/** One balanced account's usage, for what the accounts balanced on a computer used together. */
export type PoolReading = {
  /** Its latest reading, when it has one. */
  snapshot?: UsageSnapshot;
  /** A reading of it is under way, or its first one is due. */
  loading: boolean;
  /** It cannot be read now, so its last reading is only what it was. */
  failed: boolean;
  /** The kinds of limit its bars showed after its last reading on this device, when they did. */
  expected?: readonly LimitSlot[];
};

/**
 * One kind of limit as the accounts balanced on a computer used it together: the average share
 * used of the accounts whose current reading reports it, beside the average of their even-use
 * guides, each at the time of its own reading. Every account counts the same, since a reading
 * reports a share of the account's limit, not an amount.
 */
export type PoolLimit = {
  id: LimitSlot;
  label: string;
  /** The accounts the averages count: those whose current reading reports this limit. */
  counted: number;
  /** The accounts that may have this limit too but have no current reading of it. */
  unread: number;
  /** The average share used, or null while no account has a reading yet. */
  usedPercent: number | null;
  /** The average share that using each account evenly over its window would have used. */
  expectedPercent: number | null;
  pace: Pick<QuotaPace, 'state' | 'label' | 'tone' | 'detail' | 'advice'>;
};

const poolLabels: Record<LimitSlot, string> = {
  'five-hour': '5-hour',
  weekly: 'Weekly',
  'fable-weekly': 'Fable weekly',
};

/**
 * What the accounts balanced on a computer used together, limit by limit, as each account's bars
 * show its own (requested 2026-11-10): whether, all accounts taken together, more was used than
 * even use of each account would have used by now. Only current readings count, as only they
 * have a guide; an account without one, or whose reading lists only some of its limits, is
 * `unread` in every limit it may have. Until the first readings arrive, the limits the accounts
 * may have wait unmeasured: those their bars showed after their last readings on this device,
 * when every account waiting has shown its own here.
 */
export function poolUsage(
  provider: ProviderId,
  readings: readonly PoolReading[],
  now: number,
): PoolLimit[] {
  const settings: ChatSettings = { provider, model: '', reasoning: '', instructions: '' };
  const tallies = new Map<LimitSlot, { used: number[]; expected: number[]; unread: number }>();
  // The limits each account whose reading may leave some out reported.
  const incomplete: Set<LimitSlot>[] = [];
  for (const { snapshot, failed } of readings) {
    const reported = new Set<LimitSlot>();
    for (const window of visibleLimits(snapshot, settings)) {
      const slot = limitSlot(window);
      reported.add(slot);
      let tally = tallies.get(slot);
      if (!tally) tallies.set(slot, (tally = { used: [], expected: [], unread: 0 }));
      const pace = quotaPace(window, snapshot, now, failed);
      if (pace.state === 'unknown' || window.usedPercent == null || pace.expectedPercent == null)
        tally.unread++;
      else {
        tally.used.push(window.usedPercent);
        tally.expected.push(pace.expectedPercent);
      }
    }
    if (!snapshot || snapshot.partial) incomplete.push(reported);
  }
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const limits = limitSlots.flatMap((slot): PoolLimit[] => {
    const tally = tallies.get(slot);
    if (!tally?.used.length) return [];
    const usedPercent = average(tally.used);
    const expectedPercent = average(tally.expected);
    return [
      {
        id: slot,
        label: poolLabels[slot],
        counted: tally.used.length,
        unread: tally.unread + incomplete.filter((reported) => !reported.has(slot)).length,
        usedPercent,
        expectedPercent,
        pace: guidePace(usedPercent, expectedPercent),
      },
    ];
  });
  const waiting = readings.filter((reading) => reading.loading && !reading.failed);
  if (limits.length || !waiting.length) return limits;
  const expected = waiting.every((reading) => reading.expected)
    ? limitSlots.filter((slot) => waiting.some((reading) => reading.expected?.includes(slot)))
    : undefined;
  return visibleLimits(undefined, settings, true, expected).map((window): PoolLimit => ({
    id: limitSlot(window),
    label: poolLabels[limitSlot(window)],
    counted: 0,
    unread: readings.length,
    usedPercent: null,
    expectedPercent: null,
    pace: { state: 'unknown', label: 'Pace unavailable', tone: 'muted', detail: '', advice: '' },
  }));
}

/**
 * The connections balancing leaves out, each an account on one computer: those Settings left
 * out (`balanceExcludedConnections`), or, as earlier releases saved them until the next change
 * there, every connection of an account left out (`balanceExcluded`).
 */
export function excludedConnections(
  preferences: Pick<Preferences, 'balanceExcluded' | 'balanceExcludedConnections'>,
  fleet: Pick<Fleet, 'connections'>,
) {
  if (preferences.balanceExcludedConnections)
    return new Set(preferences.balanceExcludedConnections);
  const accounts = new Set(preferences.balanceExcluded);
  return new Set(fleet.connections.filter((c) => accounts.has(c.accountId)).map((c) => c.id));
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
