import { z } from 'zod';

/**
 * Reservations of this computer for performance measurements (src-tauri/src/reservations.rs):
 * a chat that measures holds the computer, other chats' commands wait until it releases it, and
 * reservations take turns. This computer's window shows them as they change; nothing is saved.
 */
export const pcReservationSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  purpose: z.string(),
  phase: z.enum(['queued', 'draining', 'open']),
  askedAt: z.number(),
  openedAt: z.number().optional(),
  minutes: z.number().optional(),
  waitingFor: z.array(z.object({ conversationId: z.string(), label: z.string() })),
  held: z.number(),
});
export type PcReservation = z.infer<typeof pcReservationSchema>;
export const pcSnapshotSchema = z.object({ reservations: z.array(pcReservationSchema) });
export type PcSnapshot = z.infer<typeof pcSnapshotSchema>;

/** The hover text of the indicator: who holds the computer, what for, and where it stands. */
export function pcReservationTitle(
  reservations: PcReservation[],
  title: (conversationId: string) => string,
): string {
  const [first, ...queued] = reservations;
  if (!first) return '';
  const parts = [`Computer reserved: ${first.purpose}`, title(first.conversationId)];
  if (first.phase === 'open') parts.push('Measuring');
  else if (first.waitingFor.length)
    parts.push(
      `Waiting for ${first.waitingFor.length} ${first.waitingFor.length === 1 ? 'command' : 'commands'}`,
    );
  if (first.held) parts.push(`${first.held} ${first.held === 1 ? 'chat waits' : 'chats wait'}`);
  if (queued.length) parts.push(`${queued.length} more in line`);
  return parts.join(' · ');
}
