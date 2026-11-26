import { describe, expect, it } from 'vitest';
import {
  pcBesideText,
  pcBusy,
  pcChatState,
  pcOutcome,
  pcOwner,
  pcQueueTitle,
  pcRecords,
  pcReservationTitle,
  pcSnapshotSchema,
  pcTotals,
  pcTurnGroups,
  pcTurnRecords,
  pcWaitCard,
  pcWaited,
  type PcReservation,
} from './pc-reservations';

const reservation = (overrides: Partial<PcReservation> = {}): PcReservation => ({
  id: 'pc-1',
  conversationId: 'bench',
  purpose: 'Benchmark of chunk meshing',
  phase: 'draining',
  askedAt: 1,
  waitingFor: [],
  held: 0,
  ...overrides,
});
const title = (id: string) => (id === 'bench' ? 'Chunk benchmark' : 'Another chat');

describe('lulls, turns, build slots and what ran beside a measurement', () => {
  it('reads a reservation waiting for a lull, the turns and the builds waiting for a slot', () => {
    const snapshot = pcSnapshotSchema.parse({
      reservations: [{ ...reservation(), phase: 'lull', holdsAt: 180_001 }],
      turns: [
        {
          id: 'turn-1',
          name: 'the landing of github.com/simpx-tech/bluevox',
          landing: true,
          conversationId: 'bench',
          purpose: 'Final pipeline and push',
          askedAt: 1,
          grantedAt: 2,
        },
        {
          id: 'turn-2',
          name: 'the landing of github.com/simpx-tech/bluevox',
          landing: true,
          conversationId: 'ui',
          purpose: 'Final pipeline and push',
          askedAt: 3,
        },
      ],
      slots: [{ conversationId: 'ui', label: '`cargo build`', since: 4 }],
    });
    expect(snapshot.reservations[0].holdsAt).toBe(180_001);
    expect(pcReservationTitle(snapshot.reservations, title)).toBe(
      'Computer reserved: Benchmark of chunk meshing · Chunk benchmark · Waiting for a lull',
    );
    const groups = pcTurnGroups(snapshot.turns);
    expect(groups.map((group) => [group.name, group.turns.length])).toEqual([
      ['the landing of github.com/simpx-tech/bluevox', 2],
    ]);
    expect(pcQueueTitle(snapshot)).toBe('1 build waits for a slot · 1 chat waits for a turn');
    expect(pcBusy(snapshot)).toBe(true);
    // A turn held with nobody waiting, and nothing else, is no reason to show the indicator.
    expect(pcBusy({ reservations: [], turns: [snapshot.turns[0]], slots: [] })).toBe(false);
    // A host older than turns and slots sends neither, nor the chats waiting and the grants.
    expect(pcSnapshotSchema.parse({ reservations: [] })).toEqual({
      reservations: [],
      turns: [],
      slots: [],
      waiting: [],
      grants: [],
    });
  });

  it('keeps turns apart from reservations in the history, and says whose work ran beside', () => {
    const history = [
      {
        id: 'pc-1',
        conversationId: 'bench',
        purpose: 'Frame timing',
        askedAt: 1,
        openedAt: 2,
        endedAt: 10,
        endedBy: 'release',
        lullMs: 0,
        contaminated: true,
        ranBeside: [
          { conversationId: 'ui', label: 'Build `cargo build`', ms: 4000 },
          {
            owner: { session: 'claude-cli' },
            name: 'cl.exe',
            ms: 6000,
            cpuAverage: 40,
            cpuPeak: 70,
          },
        ],
      },
      {
        kind: 'turn',
        id: 'turn-1',
        conversationId: 'bench',
        name: 'the landing of github.com/simpx-tech/bluevox',
        landing: true,
        purpose: 'Final pipeline and push',
        askedAt: 1,
        grantedAt: 1,
        endedAt: 20,
        endedBy: 'release',
        waitedMs: 0,
        heldMs: 19,
        waiting: 0,
      },
    ];
    const records = pcRecords(history);
    expect(records.map((record) => record.id)).toEqual(['pc-1']);
    expect(records[0].contaminated).toBe(true);
    expect(pcTotals(records).contaminated).toBe(1);
    expect(records[0].ranBeside.map((beside) => pcBesideText(beside, title))).toEqual([
      'Another chat · Build `cargo build`',
      'Claude Code outside Agent Studio · cl.exe',
    ]);
    expect(pcTurnRecords(history).map((turn) => [turn.id, turn.heldMs])).toEqual([['turn-1', 19]]);
    expect(pcOwner({ session: 'claude-app' }, title)).toBe('Claude app');
  });
});

describe('reservations of this computer', () => {
  it('reads the snapshot the host sends', () => {
    const parsed = pcSnapshotSchema.parse({
      reservations: [
        {
          id: 'pc-1',
          conversationId: 'bench',
          purpose: 'Profile',
          phase: 'open',
          askedAt: 1,
          openedAt: 2,
          waitingFor: [],
          held: 2,
        },
      ],
    });
    expect(parsed.reservations[0].phase).toBe('open');
    expect(() =>
      pcSnapshotSchema.parse({ reservations: [{ ...reservation(), phase: 'gone' }] }),
    ).toThrow();
  });

  it('says who holds the computer, what for and where it stands', () => {
    expect(pcReservationTitle([], title)).toBe('');
    expect(
      pcReservationTitle(
        [reservation({ waitingFor: [{ conversationId: 'ui', label: '`Build.bat`' }] })],
        title,
      ),
    ).toBe(
      'Computer reserved: Benchmark of chunk meshing · Chunk benchmark · Waiting for 1 command',
    );
    // A chat asked to hand over what it holds is no command.
    expect(
      pcReservationTitle(
        [
          reservation({
            waitingFor: [
              { conversationId: 'ui', label: '`Build.bat`' },
              { conversationId: 'art', label: 'handing over', handOver: true },
            ],
          }),
        ],
        title,
      ),
    ).toBe(
      'Computer reserved: Benchmark of chunk meshing · Chunk benchmark · Waiting for 1 command and 1 chat to hand over',
    );
    expect(
      pcReservationTitle(
        [reservation({ phase: 'open', held: 2 }), reservation({ id: 'pc-2', phase: 'queued' })],
        title,
      ),
    ).toBe(
      'Computer reserved: Benchmark of chunk meshing · Chunk benchmark · Measuring · 2 chats wait · 1 more in line',
    );
  });
});

describe('the history of reservations', () => {
  const record = (fields: Record<string, unknown>) => ({
    id: 'pc-1',
    conversationId: 'bench',
    purpose: 'Benchmark',
    askedAt: 1000,
    openedAt: 4000,
    endedAt: 9000,
    endedBy: 'release',
    waitedMs: 3000,
    windowMs: 5000,
    blockers: [],
    others: [],
    held: { chats: 1, ms: 2500, refused: 2, causes: [] },
    ...fields,
  });

  it('reads records newest first, leaving out what is not one and filling in older ones', () => {
    const records = pcRecords([
      record({ id: 'pc-1' }),
      'a line that is not a record',
      { id: 'pc-9' },
      // Kept before hand-overs and stops were recorded, and before held time was split.
      record({ id: 'pc-2', askedAt: 20_000, endedAt: 30_000, held: 'broken', machine: 'gone' }),
    ]);
    expect(records.map((r) => r.id)).toEqual(['pc-2', 'pc-1']);
    expect(records[0].asks).toEqual([]);
    expect(records[0].stopped).toEqual([]);
    expect(records[0].held).toEqual({ chats: 0, ms: 0, refused: 0, causes: [] });
    expect(records[0].machine).toBeNull();
    expect(records[0].idle).toEqual([]);
    expect(pcRecords('not a list')).toEqual([]);
  });

  it('keeps the idle work a window opened beside apart from what ran during it', () => {
    const watcher = { conversationId: 'ui', label: '`python3 watch-pr-comments.py`', ms: 420_000 };
    const [opened] = pcRecords([record({ idle: [watcher], contaminated: false })]);
    expect(opened.idle).toEqual([watcher]);
    expect(opened.others).toEqual([]);
    expect(opened.contaminated).toBe(false);
  });

  it('adds up what the reservations took, a window that never opened waiting to the end', () => {
    const records = pcRecords([
      record({}),
      record({ id: 'pc-2', openedAt: null, waitedMs: null, windowMs: null, endedAt: 13_000 }),
    ]);
    expect(pcWaited(records[0])).toBe(12_000);
    expect(pcTotals(records)).toEqual({
      count: 2,
      waitedMs: 15_000,
      windowMs: 5000,
      heldMs: 5000,
      refused: 4,
      contaminated: 0,
    });
  });

  it('names whose a program was and what became of one stopped', () => {
    const title = (id: string) => (id === 'art' ? 'Level art' : 'Another chat');
    expect(pcOwner({ chat: 'art' }, title)).toBe('Level art');
    expect(pcOwner('app', title)).toBe('Agent Studio');
    expect(pcOwner('system', title)).toBe('System');
    expect(pcOwner('wsl', title)).toBe('WSL');
    expect(pcOwner('user', title)).toBe('Yours');
    expect(pcOutcome('asking')).toBe('still open');
    expect(pcOutcome('something new')).toBe('something new');
  });
});

describe('where each chat stands, for its row in the sidebar and its running reply', () => {
  const snapshot = pcSnapshotSchema.parse({
    reservations: [
      reservation({ held: 1 }),
      reservation({ id: 'pc-2', conversationId: 'next', purpose: 'Profile the build', askedAt: 5 }),
    ],
    turns: [
      {
        id: 't1',
        name: 'the landing of github.com/simpx-tech/bluevox',
        landing: true,
        conversationId: 'lander',
        purpose: 'Final pipeline and push',
        askedAt: 1,
        grantedAt: 2,
      },
      {
        id: 't2',
        name: 'the landing of github.com/simpx-tech/bluevox',
        landing: true,
        conversationId: 'queued',
        purpose: 'Final pipeline and push',
        askedAt: 3,
      },
    ],
    slots: [
      { conversationId: 'builder', label: '`Tools\\Build.ps1 -Candidate`', since: 7 },
      { conversationId: 'gamer', label: '`Run-Game.ps1`', weight: 'run', since: 8 },
    ],
    waiting: ['held'],
  });
  const titles = (id: string) =>
    ({ bench: 'Chunk benchmark', lander: 'Square pin' })[id] ?? 'Another chat';

  it('marks the chat reserving, the chats waiting and the one holding a landing turn', () => {
    expect(pcChatState(snapshot, 'bench', titles)).toEqual({
      kind: 'reserving',
      measuring: false,
      title: 'Reserving the computer: Benchmark of chunk meshing',
    });
    expect(
      pcChatState({ ...snapshot, reservations: [reservation({ phase: 'open' })] }, 'bench', titles),
    ).toMatchObject({ kind: 'reserving', measuring: true });
    expect(pcChatState(snapshot, 'held', titles)).toEqual({
      kind: 'waiting',
      title: 'Waiting for the computer: Chunk benchmark reserved it: Benchmark of chunk meshing',
    });
    expect(pcChatState(snapshot, 'next', titles)?.kind).toBe('waiting');
    expect(pcChatState(snapshot, 'builder', titles)?.title).toBe(
      'Waiting for a build slot: First in line · Tools\\Build.ps1 -Candidate',
    );
    expect(pcChatState(snapshot, 'gamer', titles)?.title).toBe(
      'Waiting for room for a game or test run: 1 ahead in line · Run-Game.ps1',
    );
    expect(pcChatState(snapshot, 'queued', titles)?.title).toBe(
      'Waiting for its turn: Square pin holds the landing turn: Final pipeline and push',
    );
    expect(pcChatState(snapshot, 'lander', titles)).toEqual({
      kind: 'turn',
      title: 'Holding the landing turn',
    });
    expect(pcChatState(snapshot, 'idle', titles)).toBeUndefined();
  });

  it("gives a waiting chat's reply its card, with when its wait began where known", () => {
    expect(pcWaitCard(snapshot, 'builder', titles)).toEqual({
      heading: 'Waiting for a build slot',
      detail: 'First in line · Tools\\Build.ps1 -Candidate',
      since: 7,
    });
    expect(pcWaitCard(snapshot, 'next', titles)).toEqual({
      heading: 'In line to reserve the computer',
      detail: 'Next, behind Chunk benchmark: Benchmark of chunk meshing',
      since: 5,
    });
    expect(
      pcWaitCard({ ...snapshot, slots: [{ ...snapshot.slots[0], granted: true }] }, 'builder', titles)
        ?.heading,
    ).toBe('A build slot is free');
    expect(pcWaitCard(snapshot, 'bench', titles)).toBeUndefined();
  });

  it('reads a snapshot from before grants and waiting chats', () => {
    const old = pcSnapshotSchema.parse({
      reservations: [],
      slots: [{ conversationId: 'x', label: 'l', since: 1 }],
    });
    expect(old.waiting).toEqual([]);
    expect(old.grants).toEqual([]);
    expect(old.slots[0].weight).toBe('build');
  });
});