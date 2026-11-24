import { describe, expect, it } from 'vitest';
import {
  changedComparison,
  comparisonsSchema,
  laterRuns,
  leadChat,
  listedChats,
  mergeComparisons,
  quietRun,
  sameComparisons,
  waitingRuns,
  withComparison,
  withoutComparison,
  type Comparison,
} from './comparisons';
import { workspaceSchema } from './domain';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const location = { computerId: id(90), environmentId: id(91), path: 'C:\\Projects\\app' };
const comparison = (n: number, runs: number[], change: Partial<Comparison> = {}): Comparison => ({
  id: id(n),
  createdAt: '2026-11-24T10:00:00.000Z',
  location,
  isolation: 'worktree',
  runs: runs.map((run, i) => ({
    conversationId: id(run),
    worktree: i,
    branch: `agent-studio/compare-0000000${n}-${i + 1}`,
  })),
  at: '2026-11-24T10:00:00.000Z',
  ...change,
});
type Chat = {
  id: string;
  title: string;
  location?: typeof location;
  messages: { role: string; status: string; questions?: { status: string }[] }[];
};
const chat = (n: number, ...statuses: string[]): Chat => ({
  id: id(n),
  title: `Chat ${n}`,
  location: { ...location, path: `C:\\data\\worktrees\\abc-${n}\\app` },
  messages: [
    { role: 'user', status: 'complete' },
    ...statuses.map((status) => ({ role: 'assistant', status })),
  ],
});

describe('comparisons', () => {
  it('keeps each chat in one comparison, listed by its first run', () => {
    const list = [comparison(1, [11, 12, 13]), comparison(2, [21, 22])];
    expect(comparisonsSchema.parse(list)).toEqual(list);
    expect(leadChat(list[0])).toBe(id(11));
    expect([...laterRuns(list)]).toEqual([id(12), id(13), id(22)]);
    expect(comparisonsSchema.safeParse([...list, comparison(3, [12])]).success).toBe(false);
    expect(comparisonsSchema.safeParse([list[0], list[0]]).success).toBe(false);
    // The workspace keeps them, and an older workspace without them still reads.
    expect(workspaceSchema.shape.comparisons.parse(list)).toEqual(list);
    expect(workspaceSchema.shape.comparisons.parse(undefined)).toBeUndefined();
  });

  it('stores comparisons by id and stamps each change', () => {
    const list = withComparison(withComparison([], comparison(2, [21, 22])), comparison(1, [11]));
    expect(list.map((c) => c.id)).toEqual([id(1), id(2)]);
    const picked = changedComparison(
      list,
      id(2),
      () => ({ picked: id(22) }),
      new Date('2026-11-24T11:00:00.000Z'),
    );
    expect(picked[1]).toMatchObject({ picked: id(22), at: '2026-11-24T11:00:00.000Z' });
    // Unpicking leaves no undefined field behind, so the stored JSON says the same.
    const unpicked = changedComparison(picked, id(2), () => ({ picked: undefined }));
    expect('picked' in unpicked[1]).toBe(false);
    expect(withoutComparison(list, id(1)).map((c) => c.id)).toEqual([id(2)]);
    expect(sameComparisons(list, [...list].reverse())).toBe(true);
    expect(sameComparisons(list, picked)).toBe(false);
  });

  it('merges each side’s changes since the base, the later one winning', () => {
    const base = [comparison(1, [11, 12]), comparison(2, [21, 22])];
    const local = [
      comparison(1, [11, 12], { picked: id(11), at: '2026-11-24T10:05:00.000Z' }),
      comparison(2, [21, 22]),
      comparison(3, [31, 32]),
    ];
    const remote = [
      comparison(1, [11, 12], { picked: id(12), at: '2026-11-24T10:06:00.000Z' }),
      comparison(4, [41, 42]),
    ];
    const merged = mergeComparisons(base, local, remote)!;
    // Both picked: the later pick. Removed remotely and unchanged here: removed. New on either
    // side: kept.
    expect(merged.map((c) => c.id)).toEqual([id(1), id(3), id(4)]);
    expect(merged[0].picked).toBe(id(12));
    // A side that predates comparisons removes nothing, and is not written back to.
    expect(mergeComparisons(base, local, undefined)).toBe(local);
    expect(mergeComparisons(base, undefined, remote)).toBe(remote);
    // A comparison changed here survives its removal elsewhere.
    expect(mergeComparisons(base, local, [comparison(2, [21, 22])])!.map((c) => c.id)).toContain(
      id(1),
    );
  });

  it('lists a comparison once, read from the run that needs the reader most', () => {
    const list = [comparison(1, [11, 12, 13])];
    const asking: Chat = {
      ...chat(13, 'running'),
      messages: [
        { role: 'user', status: 'complete' },
        { role: 'assistant', status: 'running', questions: [{ status: 'pending' }] },
      ],
    };
    const chats = [chat(11, 'complete'), chat(12, 'running'), asking, chat(99, 'complete')];
    const listed = listedChats(chats, list);
    expect(listed.map((c) => c.id)).toEqual([id(11), id(99)]);
    // Its row stands in the comparison's folder, never a worktree, with the asking run's messages.
    expect(listed[0].location).toEqual(location);
    expect(listed[0].title).toBe('Chat 11');
    expect(listed[0].messages).toBe(asking.messages);
    // Without an asking run, a running one; with none running, its own.
    expect(
      listedChats([chat(11, 'complete'), chat(12, 'running'), chat(13)], list)[0].messages,
    ).toEqual(chat(12, 'running').messages);
    const done = [chat(11, 'complete'), chat(12, 'error'), chat(13, 'complete')];
    expect(listedChats(done, list)[0].messages).toBe(done[0].messages);
    // The chats themselves are never changed.
    expect(chats[0].location?.path).toContain('worktrees');
  });

  it('announces a comparison once, as its last run ends', () => {
    const list = [comparison(1, [11, 12, 13])];
    const chats = [chat(11, 'complete'), chat(12, 'running'), chat(13)];
    // Another run still runs or has not started: this one ends quietly.
    expect(quietRun(id(11), chats, list)).toBe(true);
    expect(waitingRuns(list[0], new Map(chats.map((c) => [c.id, c]))).map((c) => c.id)).toEqual([
      id(13),
    ]);
    const ended = [chat(11, 'complete'), chat(12, 'complete'), chat(13, 'cancelled')];
    expect(quietRun(id(13), ended, list)).toBe(false);
    // A chat outside comparisons is never quiet.
    expect(quietRun(id(99), ended, list)).toBe(false);
  });
});
