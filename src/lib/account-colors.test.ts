import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  accountColorIndex,
  accountColorLabel,
  accountColorNames,
  accountColorValue,
  accountColorsSchema,
  assignAccountColors,
  mergeAccountColors,
  sameAccountColors,
  shownAccountColor,
  withAccountColor,
  type AccountColor,
} from './account-colors';

// Ids in a known order, since accounts take their colors in the order of their ids.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (n: number, provider = 'claude') => ({ id: id(n), provider });
const color = (n: number, name: string, chosenAt?: string): AccountColor => ({
  accountId: id(n),
  color: name,
  ...(chosenAt ? { chosenAt } : {}),
});
const names = (colors: AccountColor[] | undefined) => (colors ?? []).map((c) => c.color);

describe('account colors', () => {
  it('has a value in each theme for every color of the palette', () => {
    expect(new Set(accountColorNames).size).toBe(accountColorNames.length);
    const theme = readFileSync('src/lib/theme.css', 'utf8');
    for (const name of accountColorNames) {
      // Once for the dark theme and once for the light one.
      expect(theme.match(new RegExp(`^  --account-${name}: #[0-9a-f]{6};`, 'gm'))).toHaveLength(2);
      expect(accountColorValue(name)).toBe(`var(--account-${name})`);
    }
    expect(theme.match(/^  --account-[a-z]+:/gm)).toHaveLength(accountColorNames.length * 2);
    expect(accountColorLabel('blue')).toBe('Blue');
    // A color this release does not draw, or none, shows as gray.
    expect(shownAccountColor('a-future-color')).toBe('gray');
    expect(shownAccountColor(undefined)).toBe('gray');
    expect(accountColorValue('a-future-color')).toBe('var(--account-gray)');
  });

  it('gives every account a color of its own while the palette lasts', () => {
    const accounts = accountColorNames.map((_, n) => account(n, n % 2 ? 'codex' : 'claude'));
    const colors = assignAccountColors(undefined, accounts)!;
    expect(colors.map((c) => c.accountId)).toEqual(accounts.map((a) => a.id));
    expect(new Set(names(colors)).size).toBe(accountColorNames.length);
    expect(new Set(names(colors))).toEqual(new Set(accountColorNames));
    // The colors easiest to tell apart go first, and none is recorded as the user's choice.
    expect(names(colors).slice(0, 4)).toEqual(['blue', 'orange', 'green', 'pink']);
    expect(colors.every((c) => c.chosenAt === undefined)).toBe(true);
    expect(accountColorsSchema.safeParse(colors).success).toBe(true);
  });

  it('gives the same accounts the same colors whatever order a device holds them in', () => {
    const accounts = [account(3), account(1, 'codex'), account(2), account(4, 'codex')];
    const colors = assignAccountColors(undefined, accounts);
    expect(assignAccountColors(undefined, [...accounts].reverse())).toEqual(colors);
    expect(names(colors)).toEqual(['blue', 'orange', 'green', 'pink']);
  });

  it('keeps the colors accounts have, and returns the list itself when nothing changes', () => {
    const accounts = [account(1), account(2), account(3)];
    const colors = assignAccountColors([color(2, 'blue', '2026-10-12T10:00:00.000Z')], accounts)!;
    // The new accounts take the next colors nobody has.
    expect(colors).toEqual([
      color(1, 'orange'),
      color(2, 'blue', '2026-10-12T10:00:00.000Z'),
      color(3, 'green'),
    ]);
    expect(assignAccountColors(colors, accounts)).toBe(colors);
    expect(assignAccountColors(undefined, [])).toBeUndefined();
    const empty: AccountColor[] = [];
    expect(assignAccountColors(empty, [])).toBe(empty);
    // A later account never changes the others, and an account that is gone gives its color up.
    const more = assignAccountColors(colors, [...accounts, account(0)])!;
    expect(more.slice(1)).toEqual(colors);
    expect(more[0]).toEqual(color(0, 'pink'));
    const fewer = assignAccountColors(more, [account(0), account(3)])!;
    expect(fewer).toEqual([color(0, 'pink'), color(3, 'green')]);
    expect(names(assignAccountColors(fewer, [account(0), account(3), account(5)]))).toEqual([
      'pink',
      'green',
      'blue',
    ]);
  });

  it('repeats a color across agents before it repeats one within an agent', () => {
    const claude = accountColorNames.map((_, n) => account(n));
    const all = assignAccountColors(undefined, claude)!;
    expect(new Set(names(all)).size).toBe(accountColorNames.length);
    // With the palette used up, another agent's account takes the first color again...
    const codex = assignAccountColors(all, [...claude, account(50, 'codex')])!;
    expect(codex.at(-1)).toEqual(color(50, 'blue'));
    // ...and one more of the same agent takes a color that agent has once, not twice.
    const twice = assignAccountColors(codex, [
      ...claude,
      account(50, 'codex'),
      account(51),
      account(52),
    ])!;
    const claudeColors = twice
      .filter((c) => c.accountId !== id(50))
      .reduce<Record<string, number>>((n, c) => ({ ...n, [c.color]: (n[c.color] ?? 0) + 1 }), {});
    expect(Math.max(...Object.values(claudeColors))).toBe(2);
    expect(Object.values(claudeColors).filter((n) => n === 2)).toHaveLength(2);
    // An unknown color a newer release gave an account counts as that account's own.
    expect(
      names(assignAccountColors([color(1, 'a-future-color')], [account(1), account(2)])),
    ).toEqual(['a-future-color', 'blue']);
  });

  it('records the color the user chose, one per account, in the same order on every device', () => {
    const colors = assignAccountColors(undefined, [account(1), account(2)])!;
    const chosen = withAccountColor(colors, id(2), 'teal', '2026-10-12T10:00:00.000Z');
    expect(chosen).toEqual([color(1, 'blue'), color(2, 'teal', '2026-10-12T10:00:00.000Z')]);
    expect(withAccountColor(undefined, id(2), 'red', '2026-10-12T10:00:00.000Z')).toEqual([
      color(2, 'red', '2026-10-12T10:00:00.000Z'),
    ]);
    expect(accountColorIndex(chosen).get(id(2))?.color).toBe('teal');
    expect(sameAccountColors(chosen, [...chosen].reverse())).toBe(true);
    expect(sameAccountColors(chosen, colors)).toBe(false);
    expect(sameAccountColors(undefined, [])).toBe(true);
  });

  it('accepts colors a newer release adds and refuses malformed or repeated accounts', () => {
    expect(accountColorsSchema.safeParse([color(1, 'a-future-color')]).success).toBe(true);
    for (const name of ['Blue', 'blue ', 'blue--x', '#71b2fb', 'var(--accent)', ''])
      expect(accountColorsSchema.safeParse([color(1, name)]).success).toBe(false);
    expect(accountColorsSchema.safeParse([color(1, 'blue'), color(1, 'red')]).success).toBe(false);
    expect(accountColorsSchema.safeParse([color(1, 'blue', 'now')]).success).toBe(false);
    expect(accountColorsSchema.safeParse([{ accountId: 'me', color: 'blue' }]).success).toBe(false);
  });

  it('merges colors from both sides and keeps them when a side predates them', () => {
    const shared = color(1, 'blue');
    const ours = color(2, 'orange');
    const theirs = color(3, 'green');
    const base = [shared];
    expect(mergeAccountColors(base, [shared, ours], [shared, theirs])).toEqual([
      shared,
      ours,
      theirs,
    ]);
    // An older relay or app drops the list: this device keeps its own.
    expect(mergeAccountColors(base, [shared, ours], undefined)).toEqual([shared, ours]);
    expect(mergeAccountColors(base, undefined, [shared, theirs])).toEqual([shared, theirs]);
    expect(mergeAccountColors(undefined, undefined, undefined)).toBeUndefined();
    // A side that changed an account's color wins over a side that kept it.
    const chosen = color(1, 'teal', '2026-10-12T10:00:00.000Z');
    expect(mergeAccountColors(base, [chosen], base)).toEqual([chosen]);
    expect(mergeAccountColors(base, base, [chosen])).toEqual([chosen]);
    // Both gave the same account a color: the user's choice over one the account took by itself,
    // then the later choice, on whichever side it is.
    const taken = color(4, 'pink');
    const picked = color(4, 'red', '2026-10-12T10:00:00.000Z');
    const repicked = color(4, 'violet', '2026-10-12T10:00:05.000Z');
    for (const [left, right, winner] of [
      [taken, picked, picked],
      [picked, taken, picked],
      [picked, repicked, repicked],
      [repicked, picked, repicked],
    ])
      expect(mergeAccountColors(base, [shared, left], [shared, right])).toEqual([shared, winner]);
    // Two devices that each let it take a color settle on the relay's.
    const other = color(4, 'yellow');
    expect(mergeAccountColors(base, [shared, taken], [shared, other])).toEqual([shared, other]);
    expect(mergeAccountColors(base, [shared, other], [shared, taken])).toEqual([shared, taken]);
    expect(mergeAccountColors([shared, taken], [shared, taken], [shared, other])).toEqual([
      shared,
      other,
    ]);
    // An older relay never took a choice this device's baseline holds: a color another device
    // lets the account take afterwards does not replace it, and a later choice there does.
    const held = [shared, picked];
    expect(mergeAccountColors(held, held, [shared, other])).toEqual(held);
    expect(mergeAccountColors(held, held, [shared, repicked])).toEqual([shared, repicked]);
    expect(mergeAccountColors([shared, repicked], [shared, repicked], held)).toEqual([
      shared,
      repicked,
    ]);
    // Removed with its account on one side and kept on the other, it goes; a removal yields to
    // a choice made meanwhile.
    expect(mergeAccountColors(base, [], base)).toEqual([]);
    expect(mergeAccountColors(base, [], [chosen])).toEqual([chosen]);
  });

  it('gives accounts that took the same color on two devices different ones, the relay’s first', () => {
    // Each computer met its own accounts before the two synced, so both started with blue.
    const here = [account(1), account(3, 'codex')];
    const there = [account(2), account(4, 'codex')];
    const local = assignAccountColors(undefined, here)!;
    const remote = assignAccountColors(undefined, there)!;
    expect(names(local)).toEqual(names(remote));
    const all = { accounts: [...here, ...there], connections: [] };
    const merged = mergeAccountColors(undefined, local, remote, all)!;
    // The relay's accounts keep theirs; this device's take the next colors nobody has.
    expect(merged).toEqual([
      color(1, 'green'),
      color(2, 'blue'),
      color(3, 'pink'),
      color(4, 'orange'),
    ]);
    // Both devices then hold the same list, and merging again changes nothing.
    expect(mergeAccountColors(merged, merged, merged, all)).toEqual(merged);
    expect(mergeAccountColors(remote, remote, merged, all)).toEqual(merged);
    // Until the relay has taken them, the same merge gives the same colors again.
    expect(mergeAccountColors(undefined, merged, remote, all)).toEqual(merged);
    // A color the user chose here stays, even one the relay holds for another account.
    const picked = withAccountColor(local, id(1), 'blue', '2026-10-12T10:00:00.000Z');
    expect(names(mergeAccountColors(undefined, picked, remote, all))).toEqual([
      'blue',
      'blue',
      'green',
      'orange',
    ]);
    // With every color taken, a new account keeps the one it took: none is better.
    const many = accountColorNames.map((_, n) => account(n + 10));
    const full = assignAccountColors(undefined, many)!;
    const extra = assignAccountColors(full, [...many, account(99)])!;
    expect(
      mergeAccountColors(full, extra, full, { accounts: [...many, account(99)], connections: [] }),
    ).toEqual(extra);
    // An account without a color takes one in the merge, and one that is gone gives its up.
    expect(
      mergeAccountColors(local, local, local, {
        accounts: [...here, account(5)],
        connections: [],
      }),
    ).toEqual([...local, color(5, 'green')]);
    expect(
      mergeAccountColors(local, local, local, {
        accounts: [account(3, 'codex')],
        connections: [],
      }),
    ).toEqual([color(3, 'orange')]);
  });

  it('keeps the accounts one computer lists together apart, even with the palette used up', () => {
    const windows = 'windows',
      server = 'server';
    const on = (n: number, ...environments: string[]) =>
      environments.map((environmentId) => ({ accountId: id(n), environmentId }));
    // Twelve accounts for ten colors: ten Claude labels nobody connected take theirs last.
    const labels = accountColorNames.map((_, n) => account(n + 20));
    const accounts = [...labels, account(1), account(2, 'codex'), account(3), account(4, 'codex')];
    const places = [...on(1, windows), ...on(2, windows), ...on(3, windows), ...on(4, server)];
    const colors = assignAccountColors(undefined, accounts, places)!;
    const colorOf = (n: number) => colors.find((c) => c.accountId === id(n))!.color;
    // The connected accounts took the first colors, whatever their ids.
    expect([1, 2, 3, 4].map(colorOf)).toEqual(['blue', 'orange', 'green', 'pink']);
    expect(
      new Set(labels.map((label) => colors.find((c) => c.accountId === label.id)!.color)).size,
    ).toBe(accountColorNames.length);
    // One more on Windows takes a color nobody there has, though every color is taken somewhere:
    // not blue, orange or green, which Windows shows, nor pink, which a Codex account has.
    const more = [...accounts, account(5, 'codex')];
    const joined = assignAccountColors(colors, more, [...places, ...on(5, windows)])!;
    const taken = joined.find((c) => c.accountId === id(5))!.color;
    expect(['blue', 'orange', 'green', 'pink']).not.toContain(taken);
    expect(joined.filter((c) => c.accountId !== id(5))).toEqual(colors);
    // An account on both computers avoids the colors of both.
    const both = assignAccountColors(
      colors,
      [...accounts, account(6)],
      [...places, ...on(6, windows, server)],
    )!;
    expect(['blue', 'orange', 'green', 'pink']).not.toContain(
      both.find((c) => c.accountId === id(6))!.color,
    );
    // Where its own agent's accounts took every color, it repeats one of another computer's.
    const claude = accountColorNames.map((_, n) => account(n + 40));
    const crowded = assignAccountColors(
      undefined,
      claude,
      claude.flatMap((a, n) => [{ accountId: a.id, environmentId: n < 9 ? windows : server }]),
    )!;
    const next = assignAccountColors(
      crowded,
      [...claude, account(60)],
      [
        ...claude.map((a, n) => ({ accountId: a.id, environmentId: n < 9 ? windows : server })),
        ...on(60, windows),
      ],
    )!;
    expect(next.find((c) => c.accountId === id(60))!.color).toBe(crowded[9].color);
  });

  it('moves a color taken here only when the relay’s colors leave the account a better one', () => {
    const at = (environmentId: string, ...accounts: { id: string }[]) =>
      accounts.map((a) => ({ accountId: a.id, environmentId }));
    // The relay holds colors for two accounts; this device let a third take the first one too.
    const remote = [color(1, 'blue'), color(2, 'orange')];
    const local = [...remote, color(3, 'blue')];
    const three = [account(1), account(2), account(3)];
    const apart = {
      accounts: three,
      connections: [...at('windows', three[0], three[1]), ...at('mac', three[2])],
    };
    // While any color is free it takes that one, though the two never share a list.
    expect(mergeAccountColors(remote, local, remote, apart)).toEqual([
      ...remote,
      color(3, 'green'),
    ]);

    // Ten accounts of another agent hold every color: three on a server, seven elsewhere.
    const others = accountColorNames.map((_, n) => account(n + 10, 'codex'));
    const full = assignAccountColors(undefined, others)!;
    expect(names(full).slice(0, 3)).toEqual(['blue', 'orange', 'green']);
    const spread = [...at('server', ...others.slice(0, 3)), ...at('elsewhere', ...others.slice(3))];
    const taken = [...full, color(3, 'blue')];
    const colorOf = (colors: AccountColor[] | undefined) =>
      colors!.find((c) => c.accountId === id(3))!.color;
    // On a computer of its own, the color it took is as good as any other: it stays.
    const alone = {
      accounts: [account(3), ...others],
      connections: [...spread, ...at('mac', account(3))],
    };
    expect(colorOf(mergeAccountColors(full, taken, full, alone))).toBe('blue');
    // Listed with the server's accounts, one of which has it, it takes the first color the
    // server does not show.
    const beside = { ...alone, connections: [...spread, ...at('server', account(3))] };
    expect(colorOf(mergeAccountColors(full, taken, full, beside))).toBe('pink');
    // Its own choice stays whatever the relay holds.
    const picked = [...full, color(3, 'blue', '2026-10-12T10:00:00.000Z')];
    expect(colorOf(mergeAccountColors(full, picked, full, beside))).toBe('blue');
    // And a color the relay has seen is no longer this device's to move.
    expect(colorOf(mergeAccountColors(taken, taken, taken, beside))).toBe('blue');
  });
});
