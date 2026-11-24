import { z } from 'zod';
import { jsonEqual } from './json-equal.ts';

/**
 * A comparison (docs/COMPARISONS.md): one task sent as several runs, each a chat of its own with
 * its own agent, account, model and reasoning, or the same ones again, shown side by side. In a
 * project folder each run works in a git worktree of its own that the computer running it made
 * from one snapshot of the folder; without a folder each works in its own Standalone folder.
 * The workspace keeps one per comparison, so every device lists it and its pick.
 */
const uuid = z.string().uuid();
const time = z.iso.datetime();

export const comparisonRunSchema = z.object({
  conversationId: uuid,
  /** The run's place among the worktrees its computer made, which names it to that computer. */
  worktree: z.number().int().nonnegative().optional(),
  /** The worktree's branch, which holds the run's work for the user's own tools. */
  branch: z.string().min(1).optional(),
});
export type ComparisonRun = z.infer<typeof comparisonRunSchema>;

export const comparisonSchema = z.object({
  id: uuid,
  createdAt: time,
  /**
   * The folder the comparison started in, where its row is listed and where a picked run's
   * changes go: the runs' own chats name their worktrees.
   */
  location: z
    .object({
      computerId: uuid,
      environmentId: uuid,
      executionEnvironmentId: uuid.optional(),
      path: z.string(),
    })
    .optional(),
  isolation: z.enum(['worktree', 'standalone']),
  runs: z.array(comparisonRunSchema).min(1),
  /** Each run starts once the one before it ends. */
  oneAtATime: z.boolean().optional(),
  /** The run the user picked. */
  picked: uuid.optional(),
  /** When the picked run's changes went into the folder. */
  applied: time.optional(),
  /** When the computer that made them removed the worktrees, and with them the runs' changes. */
  removed: time.optional(),
  /** The latest change, which decides between two devices' changes of one comparison. */
  at: time,
});
export type Comparison = z.infer<typeof comparisonSchema>;
export type ComparisonLocation = NonNullable<Comparison['location']>;

export const comparisonsSchema = z
  .array(comparisonSchema)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Each comparison once.')
  .refine((list) => {
    const runs = list.flatMap((c) => c.runs.map((r) => r.conversationId));
    return new Set(runs).size === runs.length;
  }, 'Each chat runs in one comparison.');

/** The order every device stores comparisons in, so equal lists compare equal as text. */
const stored = (list: Comparison[]) =>
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Comparisons by the chats of their runs. */
export function comparisonIndex(list: readonly Comparison[] = []) {
  const index = new Map<string, Comparison>();
  for (const comparison of list)
    for (const run of comparison.runs) index.set(run.conversationId, comparison);
  return index;
}
/** The chat a comparison is listed and opened by: its first run's. */
export const leadChat = (comparison: Comparison) => comparison.runs[0].conversationId;
/** The chats of comparisons that their lists leave out: every run's but the first. */
export function laterRuns(list: readonly Comparison[] = []) {
  const chats = new Set<string>();
  for (const comparison of list)
    for (const run of comparison.runs.slice(1)) chats.add(run.conversationId);
  return chats;
}

export const withComparison = (list: readonly Comparison[] | undefined, comparison: Comparison) =>
  stored([...(list ?? []).filter((c) => c.id !== comparison.id), comparison]);
export const withoutComparison = (list: readonly Comparison[] | undefined, id: string) =>
  stored((list ?? []).filter((c) => c.id !== id));
/** A comparison changed by `change`, stamped with the time of the change. */
export function changedComparison(
  list: readonly Comparison[] | undefined,
  id: string,
  change: (comparison: Comparison) => Partial<Comparison>,
  now = new Date(),
): Comparison[] {
  return stored(
    (list ?? []).map((c) => {
      if (c.id !== id) return c;
      const next: Comparison = { ...c, ...change(c), at: now.toISOString() };
      // A field set to undefined is gone, as the stored JSON says.
      for (const key of Object.keys(next) as (keyof Comparison)[])
        if (next[key] === undefined) delete next[key];
      return next;
    }),
  );
}

// The later of two versions of one comparison, the same one on every device.
function later(a: Comparison, b: Comparison) {
  const difference = Date.parse(a.at) - Date.parse(b.at);
  if (difference) return difference > 0 ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}
const byId = (list: readonly Comparison[] = []) => new Map(list.map((c) => [c.id, c]));
const same = (a: Comparison | undefined, b: Comparison | undefined) =>
  a === b || (!!a && !!b && jsonEqual(a, b));
/** Whether two lists hold the same comparisons, whatever their order. */
export function sameComparisons(a: readonly Comparison[] = [], b: readonly Comparison[] = []) {
  if (a.length !== b.length) return false;
  const other = byId(b);
  return a.every((comparison) => same(comparison, other.get(comparison.id)));
}
/**
 * Keeps each side's changes since the shared base: a comparison changed on both sides takes the
 * later change, and one removed on one side while the other changed it stays. A side without the
 * list predates comparisons (an older relay or app drops them), so its absence removes nothing.
 */
export function mergeComparisons(
  base: readonly Comparison[] | undefined,
  local: Comparison[] | undefined,
  remote: Comparison[] | undefined,
): Comparison[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = byId(base);
  const ours = byId(local);
  const theirs = byId(remote);
  const merged: Comparison[] = [];
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    let comparison: Comparison | undefined;
    if (same(left, right) || same(original, right)) comparison = left;
    else if (same(original, left)) comparison = right;
    else comparison = left && right ? later(left, right) : (left ?? right);
    if (comparison) merged.push(comparison);
  }
  return stored(merged);
}

type Chat = {
  id: string;
  location?: ComparisonLocation;
  messages: { role: string; status: string; questions?: unknown[]; elicitations?: unknown[] }[];
};
/** Whether a reply waits for the user: a question or form it asked and nobody answered. */
const asks = (message: Chat['messages'][number]) =>
  message.status === 'running' &&
  [...(message.questions ?? []), ...(message.elicitations ?? [])].some(
    (request) => (request as { status?: string }).status === 'pending',
  );
/**
 * The chat a list shows for a comparison: its first run's, in the comparison's own folder, with
 * the messages of the run that needs the reader most, one asking for an answer, then one still
 * running, so its row and the pending count read the whole comparison.
 */
export function comparisonFace<C extends Chat>(
  chat: C,
  comparison: Comparison,
  chats: ReadonlyMap<string, C>,
): C {
  const runs = comparison.runs
    .map((run) => chats.get(run.conversationId))
    .filter((c): c is C => !!c);
  const last = (c: C) => c.messages.at(-1);
  const shown =
    runs.find((c) => {
      const m = last(c);
      return !!m && asks(m);
    }) ??
    runs.find((c) => last(c)?.status === 'running') ??
    chat;
  return {
    ...chat,
    ...(comparison.location ? { location: comparison.location } : {}),
    messages: shown.messages,
  };
}
/** The runs of a comparison not started yet: chats whose only message is the task. */
export const waitingRuns = <C extends Chat>(
  comparison: Comparison,
  chats: ReadonlyMap<string, C>,
) =>
  comparison.runs
    .map((run) => chats.get(run.conversationId))
    .filter((c): c is C => !!c && !c.messages.some((m) => m.role === 'assistant'));
/** Whether any run of a comparison still runs. */
export const comparisonRunning = <C extends Chat>(
  comparison: Comparison,
  chats: ReadonlyMap<string, C>,
) =>
  comparison.runs.some(
    (run) => chats.get(run.conversationId)?.messages.some((m) => m.status === 'running') ?? false,
  );
/**
 * The chats a list shows, with each comparison as one: its first run's chat, read as the whole
 * comparison (`comparisonFace`), its other runs left out.
 */
export function listedChats<C extends Chat>(
  chats: readonly C[],
  list: readonly Comparison[] = [],
): C[] {
  if (!list.length) return [...chats];
  const byChat = new Map(chats.map((c) => [c.id, c]));
  const index = comparisonIndex(list);
  const later = laterRuns(list);
  return chats
    .filter((c) => !later.has(c.id))
    .map((c) => {
      const comparison = index.get(c.id);
      return comparison ? comparisonFace(c, comparison, byChat) : c;
    });
}
/**
 * Whether a run's end goes unannounced: another run of its comparison still runs or has not
 * started, and the last to end announces the comparison. Questions are announced as asked.
 */
export function quietRun<C extends Chat>(
  id: string,
  chats: readonly C[],
  list: readonly Comparison[] = [],
) {
  const comparison = comparisonIndex(list).get(id);
  if (!comparison) return false;
  const byChat = new Map(chats.map((c) => [c.id, c]));
  return comparison.runs.some((run) => {
    if (run.conversationId === id) return false;
    const chat = byChat.get(run.conversationId);
    return (
      !!chat &&
      (chat.messages.some((m) => m.status === 'running') ||
        !chat.messages.some((m) => m.role === 'assistant'))
    );
  });
}
