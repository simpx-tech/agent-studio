import { describe, expect, it } from 'vitest';
import {
  pcOutcome,
  pcOwner,
  pcRecords,
  pcReservationTitle,
  pcSnapshotSchema,
  pcTotals,
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
    ).toBe('Computer reserved: Benchmark of chunk meshing · Chunk benchmark · Waiting for 1 command');
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
    expect(pcRecords('not a list')).toEqual([]);
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
    });
  });

  it('names whose a program was and what became of one stopped', () => {
    const title = (id: string) => (id === 'art' ? 'Level art' : 'Another chat');
    expect(pcOwner({ chat: 'art' }, title)).toBe('Level art');
    expect(pcOwner('app', title)).toBe('Agent Studio');
    expect(pcOwner('system', title)).toBe('System');
    expect(pcOwner('user', title)).toBe('Yours');
    expect(pcOutcome('asking')).toBe('still open');
    expect(pcOutcome('something new')).toBe('something new');
  });
});
