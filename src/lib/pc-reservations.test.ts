import { describe, expect, it } from 'vitest';
import { pcReservationTitle, pcSnapshotSchema, type PcReservation } from './pc-reservations';

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
