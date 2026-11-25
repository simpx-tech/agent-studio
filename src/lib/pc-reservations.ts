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
  // `handOver`: a chat asked to hand over what it holds, which the window waits for.
  waitingFor: z.array(
    z.object({
      conversationId: z.string(),
      label: z.string(),
      handOver: z.boolean().optional(),
    }),
  ),
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
  else if (first.waitingFor.length) {
    const handing = first.waitingFor.filter((blocker) => blocker.handOver).length;
    const commands = first.waitingFor.length - handing;
    const waits = [
      commands && `${commands} ${commands === 1 ? 'command' : 'commands'}`,
      handing && `${handing} ${handing === 1 ? 'chat' : 'chats'} to hand over`,
    ].filter(Boolean);
    parts.push(`Waiting for ${waits.join(' and ')}`);
  }
  if (first.held) parts.push(`${first.held} ${first.held === 1 ? 'chat waits' : 'chats wait'}`);
  if (queued.length) parts.push(`${queued.length} more in line`);
  return parts.join(' · ');
}

const timedSchema = z.object({ conversationId: z.string(), label: z.string(), ms: z.number() });
const stoppedProgramSchema = z.object({ name: z.string(), outcome: z.string() });
const list = <T extends z.ZodType>(item: T) => z.array(item).catch([]);

/**
 * A reservation that ended, as this computer's history keeps it (app data
 * `reservations/history.jsonl`, src-tauri/src/reservations.rs). Records written before a field
 * existed read without it.
 */
export const pcRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  purpose: z.string(),
  minutes: z.number().nullish(),
  askedAt: z.number(),
  openedAt: z.number().nullish(),
  endedAt: z.number(),
  endedBy: z.string(),
  waitedMs: z.number().nullish(),
  windowMs: z.number().nullish(),
  blockers: list(timedSchema),
  others: list(timedSchema),
  held: z
    .object({
      chats: z.number(),
      ms: z.number(),
      refused: z.number(),
      causes: list(timedSchema),
    })
    .catch({ chats: 0, ms: 0, refused: 0, causes: [] }),
  asks: list(
    z.object({
      conversationId: z.string(),
      readMs: z.number().nullish(),
      endedMs: z.number().nullish(),
      ended: z.string().nullish(),
      programs: list(stoppedProgramSchema),
    }),
  ),
  stopped: list(
    z.object({
      by: z.string(),
      conversationId: z.string(),
      background: z.boolean().catch(false),
      programs: list(stoppedProgramSchema),
    }),
  ),
  machine: z
    .object({
      samples: z.number(),
      cpuAverage: z.number(),
      cpuPeak: z.number(),
      holderAverage: z.number(),
      othersAverage: z.number(),
      othersPeak: z.number(),
      memoryTotal: z.number(),
      memoryUsedPeak: z.number(),
      memoryAvailableLeast: z.number().nullish(),
      programs: list(
        z.object({
          name: z.string(),
          owner: z.union([z.string(), z.object({ chat: z.string() })]),
          processes: z.number(),
          cpuAverage: z.number(),
          cpuPeak: z.number(),
          memoryPeak: z.number(),
        }),
      ),
    })
    .nullish()
    .catch(null),
});
export type PcRecord = z.infer<typeof pcRecordSchema>;
export type PcProgram = NonNullable<PcRecord['machine']>['programs'][number];

/** The records of a history, newest first, leaving out what does not read as one. */
export function pcRecords(values: unknown): PcRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      const parsed = pcRecordSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.endedAt - a.endedAt);
}

/** How long a reservation waited for its window: until it opened, or until it ended unopened. */
export const pcWaited = (record: PcRecord) =>
  record.waitedMs ?? (record.openedAt == null ? Math.max(0, record.endedAt - record.askedAt) : 0);

/** What a history's reservations took, together. */
export function pcTotals(records: readonly PcRecord[]) {
  const totals = { count: 0, waitedMs: 0, windowMs: 0, heldMs: 0, refused: 0 };
  for (const record of records) {
    totals.count += 1;
    totals.waitedMs += pcWaited(record);
    totals.windowMs += record.windowMs ?? 0;
    totals.heldMs += record.held.ms;
    totals.refused += record.held.refused;
  }
  return totals;
}

/** Whose a program was, naming a chat by its title. */
export function pcOwner(owner: PcProgram['owner'], title: (id: string) => string): string {
  if (typeof owner === 'object') return title(owner.chat);
  return owner === 'app' ? 'Agent Studio' : owner === 'system' ? 'System' : 'Yours';
}

/** What became of a program stopped for a measurement (src-tauri/src/reservations/programs.rs). */
export const pcOutcomes: Record<string, string> = {
  closed: 'closed',
  ended: 'ended',
  asking: 'still open',
  closing: 'still closing',
  failed: 'not ended',
  gone: 'already gone',
};
export const pcOutcome = (outcome: string) => pcOutcomes[outcome] ?? outcome;

/** What the history records of a reservation's end. */
export const pcEndedBy = (record: PcRecord) =>
  record.endedBy === 'reply' ? 'Its reply ended' : 'Released';

/** The label of what kept a window closed: a command, or a chat asked to hand over. */
export const pcHandingOver = (label: string) => label === 'handing over';
