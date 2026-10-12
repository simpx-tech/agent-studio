import { z } from 'zod';

// Each account's color, which marks the account wherever it is named: the Agent control and its
// list, a new chat's welcome, Connections, and the notice of an account switch, so accounts with
// similar names differ at a glance. The workspace keeps one per account, so every device shows
// the same color. An account takes a color by itself when it is first seen, and Manage account
// changes it.

/** The colors an account can have, in the order the palette shows them. */
export const accountColorNames = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'brown',
  'gray',
] as const;
export type AccountColorName = (typeof accountColorNames)[number];
// The order accounts take colors in by themselves: those easiest to tell apart come first.
const takenFirst: readonly AccountColorName[] = [
  'blue',
  'orange',
  'green',
  'pink',
  'violet',
  'yellow',
  'teal',
  'red',
  'brown',
  'gray',
];

export const accountColorSchema = z.object({
  accountId: z.string().uuid(),
  // Kept as written: a color a newer release adds shows as gray on older ones.
  color: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/),
  // When the user chose it. A color an account took by itself has none, so any choice is later.
  chosenAt: z.iso.datetime().optional(),
});
export const accountColorsSchema = z
  .array(accountColorSchema)
  .refine(
    (colors) => new Set(colors.map((color) => color.accountId)).size === colors.length,
    'Each account has one color.',
  );
export type AccountColor = z.infer<typeof accountColorSchema>;
type Account = { id: string; provider: string };
/** Where an account is connected: the part of a connection that tells which accounts meet. */
type Place = { accountId: string; environmentId: string };

const palette = new Set<string>(accountColorNames);
/** The palette color a stored name is drawn in. */
export const shownAccountColor = (name: string | undefined): AccountColorName =>
  name !== undefined && palette.has(name) ? (name as AccountColorName) : 'gray';
/** A color as styles read it, the theme's own value of it: `var(--account-blue)`. */
export const accountColorValue = (name: string | undefined) =>
  `var(--account-${shownAccountColor(name)})`;
/** A color as the palette names it: Blue. */
export const accountColorLabel = (name: AccountColorName) => name[0].toUpperCase() + name.slice(1);
/** Colors by account, so a list of accounts looks each one up at once. */
export const accountColorIndex = (colors: readonly AccountColor[] = []) =>
  new Map(colors.map((color) => [color.accountId, color]));

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The order every device stores colors in, by account, so equal lists compare equal as text. */
const stored = (colors: AccountColor[]) =>
  [...colors].sort((a, b) => byId(a.accountId, b.accountId));

/**
 * Chooses colors for accounts given those the others have. A color suits an account less the
 * more accounts already have it, counted in this order: accounts of its agent on a computer it is
 * on, which the Agent picker lists together; any account on such a computer, listed with it in a
 * new chat; accounts of its agent elsewhere; any account. So the accounts shown side by side
 * differ first, and a palette smaller than the workspace repeats where it shows least.
 */
function chooser(accounts: readonly Account[], places: readonly Place[]) {
  const agent = new Map(accounts.map((account) => [account.id, account.provider]));
  const where = new Map<string, Set<string>>();
  for (const { accountId, environmentId } of places) {
    if (!where.has(accountId)) where.set(accountId, new Set());
    where.get(accountId)!.add(environmentId);
  }
  const together = (a: string, b: string) => {
    const other = where.get(b);
    for (const environment of where.get(a) ?? []) if (other?.has(environment)) return true;
    return false;
  };
  const taken = new Map<string, string>();
  const cost = (id: string, color: string) => {
    const counts = [0, 0, 0, 0];
    for (const [other, held] of taken) {
      if (other === id || held !== color) continue;
      const sameAgent = agent.get(other) === agent.get(id);
      const met = together(id, other);
      if (met && sameAgent) counts[0]++;
      if (met) counts[1]++;
      if (sameAgent) counts[2]++;
      counts[3]++;
    }
    return counts;
  };
  const lower = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  return {
    /** Records the color an account has. */
    take: (id: string, color: string) => taken.set(id, color),
    connected: (id: string) => where.has(id),
    /** The color that suits an account best, the palette's first among equals. */
    best(id: string): AccountColorName {
      let color = takenFirst[0];
      let least = cost(id, color);
      for (const candidate of takenFirst.slice(1)) {
        const counts = cost(id, candidate);
        if (lower(counts, least)) [color, least] = [candidate, counts];
      }
      return color;
    },
    /** Whether another color would suit an account better than the one it has. */
    improves: (id: string, color: string, current: string) =>
      lower(cost(id, color), cost(id, current)),
  };
}

/**
 * The colors with one for every account and none for accounts that are gone. An account without
 * one takes the color that suits it best given the others (`chooser`): one no account has while
 * the palette lasts, and otherwise one that no account beside it in a list has. Connected
 * accounts take theirs before bare labels, each group in the order of its ids, so every device
 * that sees the same accounts gives them the same colors. An account that has a color keeps it
 * whatever joins later. Returns `colors` itself when nothing changes.
 */
export function assignAccountColors(
  colors: AccountColor[] | undefined,
  accounts: readonly Account[],
  places: readonly Place[] = [],
): AccountColor[] | undefined {
  const known = new Set(accounts.map((account) => account.id));
  const kept = (colors ?? []).filter((color) => known.has(color.accountId));
  const colored = new Set(kept.map((color) => color.accountId));
  const choose = chooser(accounts, places);
  const waiting = accounts
    .filter((account) => !colored.has(account.id))
    .sort(
      (a, b) => Number(choose.connected(b.id)) - Number(choose.connected(a.id)) || byId(a.id, b.id),
    );
  if (!waiting.length && kept.length === (colors?.length ?? 0)) return colors;
  for (const color of kept) choose.take(color.accountId, color.color);
  const added = waiting.map((account) => {
    const color = choose.best(account.id);
    choose.take(account.id, color);
    return { accountId: account.id, color };
  });
  return stored([...kept, ...added]);
}

/** Gives an account the color the user chose, replacing the one it had. */
export const withAccountColor = (
  colors: readonly AccountColor[] | undefined,
  accountId: string,
  color: AccountColorName,
  chosenAt: string,
) =>
  stored([
    ...(colors ?? []).filter((entry) => entry.accountId !== accountId),
    { accountId, color, chosenAt },
  ]);

const sameColor = (a: AccountColor | undefined, b: AccountColor | undefined) =>
  a === b ||
  (!!a && !!b && a.accountId === b.accountId && a.color === b.color && a.chosenAt === b.chosenAt);
/** Whether two lists hold the same colors, whatever their order. */
export function sameAccountColors(
  a: readonly AccountColor[] = [],
  b: readonly AccountColor[] = [],
) {
  if (a.length !== b.length) return false;
  const other = accountColorIndex(b);
  return a.every((color) => sameColor(color, other.get(color.accountId)));
}
const chosen = (color: AccountColor) => (color.chosenAt ? Date.parse(color.chosenAt) : -Infinity);

/**
 * Merges this device's colors (`local`) with the relay's (`remote`). Where both hold a color for
 * an account, the user's choice wins over a color the account took by itself, then the later
 * choice, and otherwise the relay's, which every device then holds. The base plays no part in
 * that: an older relay drops the list, so a baseline can hold a choice the relay never took, and
 * a color another device then let the account take must not replace it. A color one side alone
 * holds is new there, unless the other side dropped it with its account since the base. A side
 * without the list predates account colors, so its absence removes nothing.
 *
 * Two devices that each met accounts before they synced let them take the same first colors.
 * Given the merged `fleet`, a color an account took here that the relay has not seen yields
 * when the relay's colors leave it a better one: the others had theirs first, and the account
 * takes the better color. Accounts left without one take theirs too, so the merged accounts
 * differ again without changing a color other devices already show.
 */
export function mergeAccountColors(
  base: readonly AccountColor[] | undefined,
  local: AccountColor[] | undefined,
  remote: AccountColor[] | undefined,
  fleet?: { accounts: readonly Account[]; connections: readonly Place[] },
): AccountColor[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = accountColorIndex(base);
  const ours = accountColorIndex(local);
  const theirs = accountColorIndex(remote);
  const merged = new Map<string, AccountColor>();
  // Accounts whose color was taken here and never reached the relay.
  const unseen: string[] = [];
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    let color: AccountColor | undefined;
    if (left && right) color = chosen(left) > chosen(right) ? left : right;
    else if (left) {
      color = sameColor(original, left) ? undefined : left;
      if (color && !color.chosenAt) unseen.push(id);
    } else color = sameColor(original, right) ? undefined : right;
    if (color) merged.set(id, color);
  }
  if (!fleet) return stored([...merged.values()]);
  const known = new Set(fleet.accounts.map((account) => account.id));
  for (const id of [...merged.keys()]) if (!known.has(id)) merged.delete(id);
  const choose = chooser(fleet.accounts, fleet.connections);
  for (const color of merged.values()) choose.take(color.accountId, color.color);
  for (const id of unseen.filter((id) => merged.has(id)).sort(byId)) {
    const best = choose.best(id);
    if (!choose.improves(id, best, merged.get(id)!.color)) continue;
    choose.take(id, best);
    merged.set(id, { accountId: id, color: best });
  }
  return assignAccountColors(stored([...merged.values()]), fleet.accounts, fleet.connections);
}
