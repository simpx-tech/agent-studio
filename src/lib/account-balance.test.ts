import { describe, expect, it } from 'vitest';
import {
  accountActivity,
  balanceableAccounts,
  balancedAccount,
  levelPoints,
  nearlyFull,
  type BalanceCandidate,
} from './account-balance';
import type { Message } from './domain';
import type { Fleet } from './fleet';
import type { LimitWindow, UsageSnapshot } from './usage';

const now = Date.parse('2026-10-13T12:00:00Z');
const seconds = (ms: number) => Math.floor(ms / 1000);
const hour = 3_600_000;

const limit = (
  minutes: number,
  usedPercent: number | null,
  resetsAt: LimitWindow['resetsAt'] = seconds(now + hour),
  model: string | null = null,
): LimitWindow => ({
  id: `${model ?? 'account'}-${minutes}`,
  label: minutes === 300 ? '5-hour' : 'Weekly',
  usedPercent,
  resetsAt,
  windowMinutes: minutes,
  model,
  bucket: 'claude',
});
const reading = (
  windows: LimitWindow[],
  provider = 'claude',
  live?: UsageSnapshot['live'],
): UsageSnapshot => ({
  provider,
  checkedAt: seconds(now) - 30,
  windows: windows.map((window) => ({ ...window, bucket: provider })),
  context: null,
  detail: 'Fixture',
  ...(live ? { live } : {}),
});
// A Claude account: its 5-hour and weekly usage.
const claude = (fiveHour: number | null, weekly: number | null) =>
  reading([limit(300, fiveHour), limit(10080, weekly)]);
// A Codex account as this app reads most of them: a weekly limit and no 5-hour one.
const codex = (weekly: number | null) => reading([limit(10080, weekly)], 'codex');
const account = (
  connectionId: string,
  snapshot?: UsageSnapshot,
  rest: Partial<BalanceCandidate> = {},
): BalanceCandidate => ({ connectionId, snapshot, running: 0, lastUsed: 0, ...rest });

const sonnet = { provider: 'claude' as const, model: 'sonnet' };
const gpt = { provider: 'codex' as const, model: '' };

describe('balancing new chats between accounts', () => {
  it('starts on the account that used the least of its weekly limit', () => {
    const accounts = [
      account('a', claude(62, 41)),
      account('b', claude(15, 79)),
      account('c', claude(32, 9)),
    ];
    // The 5-hour limit, which comes back within hours, does not decide while each has room on it.
    expect(balancedAccount(accounts, sonnet, now)).toBe('c');
    expect(balancedAccount([], sonnet, now)).toBeUndefined();
    expect(balancedAccount([account('only')], sonnet, now)).toBe('only');
    // Codex as this app reads most accounts, without a 5-hour limit.
    expect(
      balancedAccount(
        [account('a', codex(70)), account('b', codex(26)), account('c', codex(41))],
        gpt,
        now,
      ),
    ).toBe('b');
    // A Claude 5-hour limit without a reported share is no reason to look past the weekly one.
    expect(
      balancedAccount(
        [account('a', claude(null, 50)), account('b', claude(null, 20))],
        sonnet,
        now,
      ),
    ).toBe('b');
  });

  it('compares by the 5-hour limit once an account is nearly out of it', () => {
    expect(nearlyFull).toBe(80);
    // It leaves the rest to the replies running there, however little of its week it used.
    expect(
      balancedAccount([account('a', claude(80, 4)), account('b', claude(79, 60))], sonnet, now),
    ).toBe('b');
    // With every account nearly out of it, the one with the most room left, the weekly limit
    // deciding between accounts level on it.
    expect(
      balancedAccount([account('a', claude(95, 4)), account('b', claude(84, 60))], sonnet, now),
    ).toBe('b');
    expect(
      balancedAccount(
        [account('a', claude(82, 60)), account('b', claude(86, 4)), account('c', claude(90, 1))],
        sonnet,
        now,
      ),
    ).toBe('b');
    // An account that reports no weekly limit compares by its 5-hour one.
    expect(
      balancedAccount(
        [account('a', claude(30, null)), account('b', claude(10, null))],
        sonnet,
        now,
      ),
    ).toBe('b');
    expect(
      balancedAccount([account('a', claude(40, null)), account('b', claude(10, 20))], sonnet, now),
    ).toBe('b');
  });

  it('counts accounts within the tolerance as level and gives them turns', () => {
    expect(levelPoints).toBe(5);
    const level = (rest: Record<string, Partial<BalanceCandidate>> = {}) => [
      account('a', claude(50, 4), rest.a),
      account('b', claude(50, 0), rest.b),
      account('c', claude(50, 5), rest.c),
    ];
    // Nothing else tells them apart: the picker's order.
    expect(balancedAccount(level(), sonnet, now)).toBe('a');
    // Replies running on an account are usage its reading does not show yet.
    expect(balancedAccount(level({ a: { running: 1 } }), sonnet, now)).toBe('b');
    expect(
      balancedAccount(
        level({ a: { running: 2 }, b: { running: 1 }, c: { running: 1 } }),
        sonnet,
        now,
      ),
    ).toBe('b');
    // Then the account used longest ago, one never used first.
    expect(
      balancedAccount(
        level({ a: { lastUsed: now - 60_000 }, b: { lastUsed: now - 120_000 } }),
        sonnet,
        now,
      ),
    ).toBe('c');
    expect(
      balancedAccount(
        level({
          a: { lastUsed: now - 60_000 },
          b: { lastUsed: now - 120_000 },
          c: { lastUsed: now - 1000 },
        }),
        sonnet,
        now,
      ),
    ).toBe('b');
    // One point past the tolerance is not level, however busy the least used account is.
    const apart = [account('a', claude(0, 6)), account('b', claude(50, 0), { running: 3 })];
    expect(balancedAccount(apart, sonnet, now)).toBe('b');
  });

  it('lets the 5-hour limit decide between accounts level on the weekly one', () => {
    const accounts = [
      account('a', claude(70, 0)),
      account('b', claude(13, 3)),
      account('c', claude(40, 5)),
    ];
    expect(balancedAccount(accounts, sonnet, now)).toBe('b');
    // Running replies count before it, since their usage does not show in the readings yet.
    expect(
      balancedAccount(
        accounts.map((a) => (a.connectionId === 'b' ? { ...a, running: 1 } : a)),
        sonnet,
        now,
      ),
    ).toBe('c');
    // An unreported 5-hour limit comes after any reported one.
    expect(
      balancedAccount([account('a', claude(null, 0)), account('b', claude(79, 2))], sonnet, now),
    ).toBe('b');
  });

  it('leaves an account whose limit is used up for last', () => {
    // The 5-hour limit, and the weekly one of an account with the most room on its 5-hour one.
    expect(
      balancedAccount([account('a', claude(100, 10)), account('b', claude(96, 10))], sonnet, now),
    ).toBe('b');
    expect(
      balancedAccount([account('a', claude(0, 100)), account('b', claude(80, 95))], sonnet, now),
    ).toBe('b');
    // An account without a reading may have room; one with room is known to, also once nearly
    // out of its 5-hour limit.
    expect(balancedAccount([account('a'), account('b', claude(50, 90))], sonnet, now)).toBe('b');
    expect(balancedAccount([account('a'), account('b', claude(90, 90))], sonnet, now)).toBe('b');
    expect(balancedAccount([account('a', claude(100, 10)), account('b')], sonnet, now)).toBe('b');
    expect(
      balancedAccount(
        [account('a', claude(null, null)), account('b', claude(100, 1))],
        sonnet,
        now,
      ),
    ).toBe('a');
    // With every limit used up, the account that can answer again first.
    const spent = [
      account('a', reading([limit(300, 100, seconds(now + 3 * hour)), limit(10080, 40)])),
      account('b', reading([limit(300, 100, seconds(now + hour)), limit(10080, 40)])),
      account(
        'c',
        reading([
          limit(300, 100, seconds(now + hour / 2)),
          limit(10080, 100, seconds(now + 9 * hour)),
        ]),
      ),
    ];
    expect(balancedAccount(spent, sonnet, now)).toBe('b');
  });

  it('counts a limit whose window ended since its reading as unused', () => {
    const ended = reading([
      limit(300, 100, seconds(now - 60_000)),
      limit(10080, 30, '2026-10-14T12:00:00.001061+00:00'),
    ]);
    expect(balancedAccount([account('a', claude(20, 30)), account('b', ended)], sonnet, now)).toBe(
      'b',
    );
    // Claude reports a 5-hour limit nobody is using as 0% without a reset time.
    const idle = reading([limit(300, 0, null), limit(10080, 30)]);
    expect(balancedAccount([account('a', claude(20, 30)), account('b', idle)], sonnet, now)).toBe(
      'b',
    );
    // A week that began again counts as unused, and leaves the 5-hour limit as it was.
    const week = (fiveHour: number) =>
      reading([limit(300, fiveHour), limit(10080, 100, seconds(now - 1000))]);
    expect(
      balancedAccount([account('a', week(50)), account('b', claude(20, 10))], sonnet, now),
    ).toBe('a');
    expect(
      balancedAccount([account('a', week(85)), account('b', claude(20, 10))], sonnet, now),
    ).toBe('b');
  });

  it('counts a model’s own limit only for a chat with that model', () => {
    const fable = (own: number) =>
      reading([limit(300, 0), limit(10080, 10), limit(10080, own, undefined, 'fable')]);
    const accounts = [account('a', fable(100)), account('b', claude(40, 60))];
    expect(balancedAccount(accounts, sonnet, now)).toBe('a');
    expect(balancedAccount(accounts, { provider: 'claude', model: 'fable' }, now)).toBe('b');
    // A Fable chat compares by the more used of the account's weekly limit and Fable's own.
    const used = [account('a', fable(70)), account('b', claude(40, 60))];
    expect(balancedAccount(used, sonnet, now)).toBe('a');
    expect(balancedAccount(used, { provider: 'claude', model: 'fable' }, now)).toBe('b');
  });

  it('believes Claude when it refuses replies over an account-wide limit', () => {
    const refused = (limitType: string, resetsAt: number | null) =>
      reading([limit(300, 97), limit(10080, 10)], 'claude', {
        accountChanged: 'epoch:1',
        authMode: null,
        planType: null,
        limitStatus: {
          status: 'rejected',
          limitType,
          resetsAt,
          usingOverage: false,
          checkedAt: seconds(now),
        },
      });
    const other = account('b', claude(99, 10));
    expect(
      balancedAccount(
        [account('a', refused('five_hour', seconds(now + hour))), other],
        sonnet,
        now,
      ),
    ).toBe('b');
    // Not once that limit began again, without knowing when it does, or over one model's limit.
    for (const snapshot of [
      refused('five_hour', seconds(now - 1)),
      refused('five_hour', null),
      refused('seven_day_opus', seconds(now + hour)),
    ])
      expect(balancedAccount([account('a', snapshot), other], sonnet, now)).toBe('a');
  });

  it('keeps the account a chat has while no other is better by more than the tolerance', () => {
    const accounts = [account('a', claude(10, 0)), account('b', claude(60, 5), { running: 4 })];
    expect(balancedAccount(accounts, sonnet, now)).toBe('a');
    expect(balancedAccount(accounts, sonnet, now, 'b')).toBe('b');
    // It moves once the difference is more than that, it is nearly out of its 5-hour limit while
    // another account has room, its limit is used up, or it is gone.
    const apart = [account('a', claude(10, 0)), account('b', claude(10, 6))];
    expect(balancedAccount(apart, sonnet, now, 'b')).toBe('a');
    const nearly = [account('a', claude(10, 60)), account('b', claude(85, 0))];
    expect(balancedAccount(nearly, sonnet, now, 'b')).toBe('a');
    const spent = [account('a', claude(99, 10)), account('b', claude(100, 10))];
    expect(balancedAccount(spent, sonnet, now, 'b')).toBe('a');
    expect(balancedAccount(accounts, sonnet, now, 'removed')).toBe('a');
    // An account with a reading and room is better than one without a reading.
    expect(balancedAccount([account('a'), account('b', claude(50, 50))], sonnet, now, 'a')).toBe(
      'b',
    );
    expect(balancedAccount([account('a'), account('b')], sonnet, now, 'b')).toBe('b');
  });
});

describe('what the saved chats say about each account', () => {
  const reply = (connectionId: string, createdAt: string, status: Message['status'] = 'complete') =>
    ({
      id: crypto.randomUUID(),
      role: 'assistant',
      blocks: [],
      status,
      createdAt,
      settings: { connectionId, provider: 'claude', model: '', reasoning: '', instructions: '' },
    }) as Message;
  const user = (createdAt: string) =>
    ({
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [],
      status: 'complete',
      createdAt,
    }) as Message;
  // Two connections of one account, as on a computer and in its WSL distribution.
  const accountOf = (connectionId: string) =>
    ({ windows: 'first', wsl: 'first', other: 'second' })[connectionId];

  it('counts running replies and the latest reply of each account', () => {
    const activity = accountActivity(
      [
        { messages: [user('2026-10-13T09:00:00Z'), reply('windows', '2026-10-13T09:00:01Z')] },
        {
          messages: [user('2026-10-13T10:00:00Z'), reply('wsl', '2026-10-13T10:00:01Z', 'running')],
        },
        { messages: [reply('other', '2026-10-13T08:00:00Z'), user('2026-10-13T11:00:00Z')] },
        { messages: [reply('windows', '2026-10-12T08:00:00Z', 'running')] },
        // A chat counts for the account that answered it last.
        {
          messages: [
            reply('other', '2026-10-13T11:30:00Z'),
            reply('windows', '2026-10-13T07:00:00Z'),
          ],
        },
        { messages: [reply('unknown', '2026-10-13T11:59:00Z', 'running')] },
        { messages: [user('2026-10-13T11:59:00Z')] },
        { messages: [] },
      ],
      accountOf,
    );
    expect(activity.get('first')).toEqual({
      running: 2,
      lastUsed: Date.parse('2026-10-13T10:00:01Z'),
    });
    expect(activity.get('second')).toEqual({
      running: 0,
      lastUsed: Date.parse('2026-10-13T08:00:00Z'),
    });
    expect([...activity.keys()]).toEqual(['first', 'second']);
  });
});

describe('the accounts that can be left out of balancing', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const account = (n: number, provider: Fleet['accounts'][number]['provider'], name: string) => ({
    id: id(n),
    name,
    provider,
    purpose: 'personal' as const,
  });
  const connection = (n: number, accountId: number, environmentId: number) => ({
    id: id(100 + n),
    accountId: id(accountId),
    environmentId: id(environmentId),
    profile: 'isolated' as const,
  });
  const [windows, wsl, server] = [50, 51, 52];

  it('lists accounts connected beside another account of their agent, with where', () => {
    const fleet = {
      accounts: [
        account(1, 'claude', 'First'),
        account(2, 'codex', 'Only Codex'),
        account(3, 'claude', 'Second'),
        account(4, 'claude', 'Server login'),
        account(5, 'gemini', 'Gemini CLI login'),
        account(6, 'claude', 'Never connected'),
        account(7, 'codex', 'Second Codex'),
      ],
      connections: [
        connection(1, 1, windows),
        connection(2, 3, windows),
        connection(3, 1, wsl),
        connection(4, 3, wsl),
        // Alone of its agent wherever it is connected: nothing to balance it with.
        connection(5, 2, windows),
        connection(6, 7, wsl),
        connection(7, 4, server),
        connection(8, 5, windows),
        // Two connections of one account are still one account.
        connection(9, 4, server),
      ],
    };
    expect(balanceableAccounts(fleet)).toEqual([
      { ...fleet.accounts[0], environmentIds: [id(windows), id(wsl)] },
      { ...fleet.accounts[2], environmentIds: [id(windows), id(wsl)] },
    ]);
    // A second Codex account beside the first joins both, where they meet.
    const more = { ...fleet, connections: [...fleet.connections, connection(10, 2, wsl)] };
    expect(balanceableAccounts(more).map((a) => [a.name, a.environmentIds])).toEqual([
      ['First', [id(windows), id(wsl)]],
      ['Only Codex', [id(wsl)]],
      ['Second', [id(windows), id(wsl)]],
      ['Second Codex', [id(wsl)]],
    ]);
    expect(balanceableAccounts({ accounts: [], connections: [] })).toEqual([]);
    // A connection whose account is gone counts for nothing.
    expect(
      balanceableAccounts({
        accounts: [fleet.accounts[0]],
        connections: [connection(1, 1, windows), connection(2, 3, windows)],
      }),
    ).toEqual([]);
  });
});
