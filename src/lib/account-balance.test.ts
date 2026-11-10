import { describe, expect, it } from 'vitest';
import {
  accountActivity,
  balanceGroups,
  balancedAccount,
  excludedConnections,
  levelPoints,
  poolUsage,
  type BalanceCandidate,
  type PoolReading,
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
  it('starts on the account that used the least of its 5-hour limit', () => {
    const accounts = [
      account('a', claude(62, 4)),
      account('b', claude(15, 79)),
      account('c', claude(32, 90)),
    ];
    // The weekly limit does not decide while the 5-hour ones differ.
    expect(balancedAccount(accounts, sonnet, now)).toBe('b');
    expect(balancedAccount([], sonnet, now)).toBeUndefined();
    expect(balancedAccount([account('only')], sonnet, now)).toBe('only');
  });

  it('compares by the weekly limit when no 5-hour limit is reported', () => {
    const accounts = [account('a', codex(70)), account('b', codex(26)), account('c', codex(41))];
    expect(balancedAccount(accounts, gpt, now)).toBe('b');
    // A Claude 5-hour limit without a reported share is no limit to compare by either.
    expect(
      balancedAccount(
        [account('a', claude(null, 50)), account('b', claude(null, 20))],
        sonnet,
        now,
      ),
    ).toBe('b');
    // An account that reports one compares by it, another by its weekly limit.
    expect(
      balancedAccount([account('a', claude(40, 5)), account('b', claude(null, 20))], sonnet, now),
    ).toBe('b');
  });

  it('shares what is left of an account between the replies running there and the new chat', () => {
    // A reply running on the least used account leaves the new chat half of what is left there.
    expect(
      balancedAccount(
        [account('a', claude(0, 50), { running: 1 }), account('b', claude(45, 50))],
        sonnet,
        now,
      ),
    ).toBe('b');
    expect(
      balancedAccount(
        [account('a', claude(0, 50), { running: 1 }), account('b', claude(60, 50))],
        sonnet,
        now,
      ),
    ).toBe('a');
    // Chats started one after another, before any reading shows them, spread over the accounts
    // instead of all starting on the one that looked least used.
    const running = { a: 0, b: 0 };
    const chosen = Array.from({ length: 6 }, () => {
      const choice = balancedAccount(
        [
          account('a', claude(0, 50), { running: running.a }),
          account('b', claude(30, 10), { running: running.b }),
        ],
        sonnet,
        now,
      ) as 'a' | 'b';
      running[choice]++;
      return choice;
    });
    expect(chosen).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    // The readings of 2026-10-26: an account whose week had just begun took three chats at 31%,
    // 60% and 68% of its 5-hour limit, beside the replies already running there, and used it up
    // within the hour; the next chat found the other account at 2% of its own.
    const other = account('other', claude(2, 48));
    for (const [fiveHour, weekly, replies] of [
      [31, 4, 1],
      [60, 9, 1],
      [68, 10, 2],
    ])
      expect(
        balancedAccount(
          [account('fresh', claude(fiveHour, weekly), { running: replies }), other],
          sonnet,
          now,
        ),
      ).toBe('other');
  });

  it('counts accounts within the tolerance as level and gives them turns', () => {
    expect(levelPoints).toBe(5);
    const level = (rest: Record<string, Partial<BalanceCandidate>> = {}) => [
      account('a', claude(4, 50), rest.a),
      account('b', claude(0, 50), rest.b),
      account('c', claude(5, 50), rest.c),
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
    // One point past the tolerance is not level, however much less of its week the other used.
    const apart = [account('a', claude(6, 0)), account('b', claude(0, 99))];
    expect(balancedAccount(apart, sonnet, now)).toBe('b');
  });

  it('lets the weekly limit decide between accounts level on the 5-hour one', () => {
    const accounts = [
      account('a', claude(0, 92)),
      account('b', claude(3, 13)),
      account('c', claude(5, 40)),
    ];
    expect(balancedAccount(accounts, sonnet, now)).toBe('b');
    // A reply running there leaves an account half its room for the new chat, before the weekly
    // limit decides.
    expect(
      balancedAccount(
        accounts.map((a) => (a.connectionId === 'b' ? { ...a, running: 1 } : a)),
        sonnet,
        now,
      ),
    ).toBe('c');
    // An unreported weekly limit comes after any reported one.
    expect(
      balancedAccount([account('a', claude(0, null)), account('b', claude(2, 99))], sonnet, now),
    ).toBe('b');
  });

  it('leaves an account whose limit is used up for last', () => {
    // The 5-hour limit, and the weekly one of an account whose 5-hour usage is the lowest.
    expect(
      balancedAccount([account('a', claude(100, 10)), account('b', claude(96, 10))], sonnet, now),
    ).toBe('b');
    expect(
      balancedAccount([account('a', claude(0, 100)), account('b', claude(80, 95))], sonnet, now),
    ).toBe('b');
    // An account without a reading may have room; one with room is known to.
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
    // A week that began again leaves the 5-hour limit as it was.
    const week = reading([limit(300, 50), limit(10080, 100, seconds(now - 1000))]);
    expect(balancedAccount([account('a', week), account('b', claude(70, 10))], sonnet, now)).toBe(
      'a',
    );
  });

  it('counts a model’s own limit only for a chat with that model', () => {
    const fable = (own: number) =>
      reading([limit(300, 0), limit(10080, 10), limit(10080, own, undefined, 'fable')]);
    const accounts = [account('a', fable(100)), account('b', claude(40, 60))];
    expect(balancedAccount(accounts, sonnet, now)).toBe('a');
    expect(balancedAccount(accounts, { provider: 'claude', model: 'fable' }, now)).toBe('b');
    // Between accounts level on the 5-hour limit, a Fable chat goes by the more used of the
    // account's weekly limit and Fable's own.
    const level = [account('a', fable(70)), account('b', claude(3, 60))];
    expect(balancedAccount(level, sonnet, now)).toBe('a');
    expect(balancedAccount(level, { provider: 'claude', model: 'fable' }, now)).toBe('b');
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
    const accounts = [account('a', claude(0, 10)), account('b', claude(5, 90))];
    expect(balancedAccount(accounts, sonnet, now)).toBe('a');
    expect(balancedAccount(accounts, sonnet, now, 'b')).toBe('b');
    // It moves once the difference is more than that, a reply that started there meanwhile
    // leaves it less room, its limit is used up, or it is gone.
    const apart = [account('a', claude(0, 10)), account('b', claude(6, 10))];
    expect(balancedAccount(apart, sonnet, now, 'b')).toBe('a');
    const busy = [account('a', claude(0, 10)), account('b', claude(5, 90), { running: 1 })];
    expect(balancedAccount(busy, sonnet, now, 'b')).toBe('a');
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

describe('what the accounts balanced on a computer used together', () => {
  const checked = seconds(now) - 30;
  // A limit read when `share` percent of its window had passed, so its even-use guide is `share`.
  const guided = (minutes: number, used: number | null, share: number, model?: string) =>
    limit(minutes, used, checked + Math.round((1 - share / 100) * minutes * 60), model ?? null);
  const current = (snapshot: UsageSnapshot): PoolReading => ({
    snapshot,
    loading: false,
    failed: false,
  });
  const pool = (readings: PoolReading[], provider: 'claude' | 'codex' = 'claude') =>
    poolUsage(provider, readings, now).map(({ id, label, counted, unread, pace, ...rest }) => ({
      id,
      label,
      counted,
      unread,
      used: rest.usedPercent,
      expected: rest.expectedPercent == null ? null : Number(rest.expectedPercent.toFixed(6)),
      pace: pace.state,
    }));

  it('averages the share used and the guide of each account, each at its own reading', () => {
    const readings = [
      current(reading([guided(300, 70, 50), guided(10080, 40, 60)])),
      current(reading([guided(300, 50, 70), guided(10080, 20, 20)])),
    ];
    expect(pool(readings)).toEqual([
      // One account ahead of its guide and one below it are on track together.
      {
        id: 'five-hour',
        label: '5-hour',
        counted: 2,
        unread: 0,
        used: 60,
        expected: 60,
        pace: 'on-track',
      },
      {
        id: 'weekly',
        label: 'Weekly',
        counted: 2,
        unread: 0,
        used: 30,
        expected: 40,
        pace: 'below',
      },
    ]);
    const [, weekly] = poolUsage('claude', readings, now);
    expect(weekly.pace).toMatchObject({
      label: 'Below pace',
      tone: 'good',
      detail: '10.0 percentage points below the even-use guide.',
    });
  });

  it('is ahead of pace when the accounts together used more than their guides', () => {
    const [fiveHour] = poolUsage(
      'claude',
      [
        current(reading([guided(300, 90, 50)])),
        current(reading([guided(300, 30, 40)])),
        current(reading([guided(300, 45, 30)])),
      ],
      now,
    );
    expect(fiveHour.usedPercent).toBe(55);
    expect(fiveHour.expectedPercent).toBeCloseTo(40, 6);
    expect(fiveHour.pace).toMatchObject({ state: 'ahead', label: 'Ahead of pace', tone: 'watch' });
    // Reached only once every account used it up.
    const spent = [
      current(reading([guided(300, 100, 50)])),
      current(reading([guided(300, 100, 90)])),
    ];
    expect(pool(spent)[0].pace).toBe('exhausted');
    expect(pool([spent[0], current(reading([guided(300, 0, 90)]))])[0]).toMatchObject({
      used: 50,
      expected: 70,
      pace: 'below',
    });
  });

  it('counts each limit over the accounts that report it', () => {
    // A Claude plan without a 5-hour limit, and a Codex account as most read: weekly alone.
    expect(
      pool([
        current(reading([guided(300, 80, 50), guided(10080, 40, 50)])),
        current(reading([guided(10080, 60, 50)])),
      ]),
    ).toEqual([
      {
        id: 'five-hour',
        label: '5-hour',
        counted: 1,
        unread: 0,
        used: 80,
        expected: 50,
        pace: 'ahead',
      },
      {
        id: 'weekly',
        label: 'Weekly',
        counted: 2,
        unread: 0,
        used: 50,
        expected: 50,
        pace: 'on-track',
      },
    ]);
    expect(
      pool([current(codex(70)), current(reading([guided(10080, 10, 40)], 'codex'))], 'codex').map(
        (limit) => [limit.id, limit.counted],
      ),
    ).toEqual([['weekly', 2]]);
    // A Fable chat's own weekly limit, which a reading reports when its CLI runs Fable by default.
    const fable = (used: number, share: number): UsageSnapshot => ({
      ...reading([guided(10080, 20, 50), guided(10080, used, share, 'fable')]),
      context: { model: 'claude-fable-5', tokens: 1_000_000, source: 'Fixture' },
    });
    expect(pool([current(fable(90, 50)), current(fable(50, 30))])).toEqual([
      expect.objectContaining({ id: 'weekly', used: 20, pace: 'below' }),
      expect.objectContaining({
        id: 'fable-weekly',
        label: 'Fable weekly',
        used: 70,
        expected: 40,
        pace: 'ahead',
      }),
    ]);
  });

  it('leaves out accounts without a current reading, and says how many', () => {
    const fresh = current(reading([guided(300, 60, 50), guided(10080, 40, 40)]));
    const old: PoolReading = current({
      ...reading([guided(300, 99, 50), guided(10080, 99, 50)]),
      checkedAt: seconds(now) - 600,
    });
    const failed: PoolReading = { ...current(claude(99, 99)), failed: true };
    const loading: PoolReading = { loading: true, failed: false };
    expect(pool([fresh, old, failed, loading])).toEqual([
      expect.objectContaining({ id: 'five-hour', counted: 1, unread: 3, used: 60 }),
      expect.objectContaining({ id: 'weekly', counted: 1, unread: 3, used: 40 }),
    ]);
    // Live updates alone name the limits they concern: the account may have the others too.
    const live: PoolReading = current({
      ...reading([guided(10080, 80, 40)]),
      partial: true,
    });
    expect(pool([fresh, live])).toEqual([
      expect.objectContaining({ id: 'five-hour', counted: 1, unread: 1, used: 60 }),
      expect.objectContaining({ id: 'weekly', counted: 2, unread: 0, used: 60 }),
    ]);
  });

  it('waits for the first readings, and shows nothing without one coming', () => {
    const loading: PoolReading = { loading: true, failed: false };
    expect(pool([loading, loading])).toEqual([
      {
        id: 'five-hour',
        label: '5-hour',
        counted: 0,
        unread: 2,
        used: null,
        expected: null,
        pace: 'unknown',
      },
      {
        id: 'weekly',
        label: 'Weekly',
        counted: 0,
        unread: 2,
        used: null,
        expected: null,
        pace: 'unknown',
      },
    ]);
    // An account that cannot be read now is not being read.
    expect(pool([{ loading: true, failed: true }])).toEqual([]);
    expect(pool([{ ...current(claude(40, 40)), failed: true }])).toEqual([]);
    expect(pool([])).toEqual([]);
  });
});

describe('where Settings narrows balancing', () => {
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
  const [desktop, vps, windows, wsl, server] = [40, 41, 50, 51, 52];
  // A desktop with its WSL distribution, which Connections shows as a computer of its own, and a
  // server, listed in another order than the computers they belong to.
  const places = {
    computers: [
      { id: id(desktop), name: 'Desktop' },
      { id: id(vps), name: 'VPS' },
    ],
    environments: [
      { id: id(server), computerId: id(vps), name: 'Linux', platform: 'linux' as const },
      {
        id: id(wsl),
        computerId: id(desktop),
        name: 'WSL · Ubuntu',
        platform: 'wsl' as const,
        discoveredOn: id(windows),
      },
      { id: id(windows), computerId: id(desktop), name: 'Windows', platform: 'windows' as const },
    ],
  };
  const fleet: Fleet = {
    ...places,
    accounts: [
      account(1, 'claude', 'First'),
      account(2, 'codex', 'Only Codex'),
      account(3, 'claude', 'Second'),
      account(4, 'claude', 'Server login'),
      account(5, 'gemini', 'Gemini CLI login'),
      account(6, 'claude', 'Never connected'),
      account(7, 'codex', 'Second Codex'),
      account(8, 'claude', 'Server work'),
    ],
    connections: [
      connection(1, 1, windows),
      connection(2, 3, windows),
      connection(3, 1, wsl),
      connection(4, 3, wsl),
      // Alone of its agent wherever it is connected: nothing to balance it with.
      connection(5, 2, windows),
      connection(6, 7, wsl),
      connection(8, 5, windows),
      connection(7, 4, server),
      connection(9, 8, server),
    ],
  };
  const groups = (fleet: Fleet) =>
    balanceGroups(fleet).map(({ provider, environmentId, connections }) => [
      provider,
      environmentId,
      connections.map((c) => c.id),
    ]);

  it('groups each agent’s accounts by the computer where several of them meet', () => {
    expect(groups(fleet)).toEqual([
      ['claude', id(windows), [id(101), id(102)]],
      ['claude', id(wsl), [id(103), id(104)]],
      ['claude', id(server), [id(107), id(109)]],
    ]);
    // A second Codex account beside the first adds Codex, ahead of Claude as the picker lists it,
    // where they meet.
    const more = { ...fleet, connections: [...fleet.connections, connection(10, 2, wsl)] };
    expect(groups(more)[0]).toEqual(['codex', id(wsl), [id(106), id(110)]]);
    expect(groups(more)).toHaveLength(4);
    expect(balanceGroups({ ...places, accounts: [], connections: [] })).toEqual([]);
    // A connection whose account is gone counts for nothing.
    expect(
      balanceGroups({
        ...places,
        accounts: [fleet.accounts[0]],
        connections: [connection(1, 1, windows), connection(2, 3, windows)],
      }),
    ).toEqual([]);
  });

  it('leaves accounts out on one computer, or as earlier releases did on all of them', () => {
    const none = excludedConnections({}, fleet);
    expect([...none]).toEqual([]);
    // An account left out by an earlier release is left out wherever it is connected...
    expect([...excludedConnections({ balanceExcluded: [id(1)] }, fleet)]).toEqual([
      id(101),
      id(103),
    ]);
    // ...until the list names connections, which replace it, an empty list included.
    expect([
      ...excludedConnections(
        { balanceExcluded: [id(1)], balanceExcludedConnections: [id(103)] },
        fleet,
      ),
    ]).toEqual([id(103)]);
    expect([
      ...excludedConnections({ balanceExcluded: [id(1)], balanceExcludedConnections: [] }, fleet),
    ]).toEqual([]);
  });
});
