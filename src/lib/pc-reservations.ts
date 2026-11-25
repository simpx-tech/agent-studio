import { z } from 'zod';

/**
 * Reservations of this computer for performance measurements (src-tauri/src/reservations.rs):
 * a chat that measures holds the computer, other chats' commands wait until it releases it, and
 * reservations take turns. First in line, a reservation waits for a lull (`lull`) before it
 * holds other chats' new work (`draining`). The same broker keeps chats' builds waiting for a
 * slot and named reservations, such as a repository's landing turn. This computer's window shows
 * them as they change; nothing is saved.
 */
export const pcReservationSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  purpose: z.string(),
  phase: z.enum(['queued', 'lull', 'draining', 'open']),
  askedAt: z.number(),
  /** While it waits for a lull: when it holds other chats' new work if none comes. */
  holdsAt: z.number().optional(),
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
/** A chat's turn at a named reservation: the first of each name holds it. */
export const pcTurnSchema = z.object({
  id: z.string(),
  name: z.string(),
  landing: z.boolean(),
  conversationId: z.string(),
  purpose: z.string(),
  askedAt: z.number(),
  grantedAt: z.number().optional(),
});
export type PcTurn = z.infer<typeof pcTurnSchema>;
/** A chat's build waiting for a slot beside the builds running. */
export const pcSlotSchema = z.object({
  conversationId: z.string(),
  label: z.string(),
  since: z.number(),
  granted: z.boolean().optional(),
});
export type PcSlot = z.infer<typeof pcSlotSchema>;
export const pcSnapshotSchema = z.object({
  reservations: z.array(pcReservationSchema),
  turns: z.array(pcTurnSchema).catch([]),
  slots: z.array(pcSlotSchema).catch([]),
});
export type PcSnapshot = z.infer<typeof pcSnapshotSchema>;

/** Named reservations by name, each with its holder first, in the order they were asked for. */
export function pcTurnGroups(turns: readonly PcTurn[]): { name: string; turns: PcTurn[] }[] {
  const groups = new Map<string, PcTurn[]>();
  for (const turn of turns) {
    const key = turn.landing ? `landing:${turn.name}` : turn.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), turn]);
  }
  return [...groups.values()].map((list) => ({ name: list[0].name, turns: list }));
}

/** Whether anything waits on this computer: a reservation, a build for a slot or a turn. */
export const pcBusy = (snapshot: Pick<PcSnapshot, 'reservations' | 'turns' | 'slots'>) =>
  snapshot.reservations.length > 0 ||
  snapshot.slots.length > 0 ||
  snapshot.turns.some((turn) => turn.grantedAt == null);

/** The hover text of the indicator: who holds the computer, what for, and where it stands. */
export function pcReservationTitle(
  reservations: PcReservation[],
  title: (conversationId: string) => string,
): string {
  const [first, ...queued] = reservations;
  if (!first) return '';
  const parts = [`Computer reserved: ${first.purpose}`, title(first.conversationId)];
  if (first.phase === 'open') parts.push('Measuring');
  else if (first.phase === 'lull') parts.push('Waiting for a lull');
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

/** The hover text of the indicator while builds wait for a slot or chats for a turn. */
export function pcQueueTitle(snapshot: Pick<PcSnapshot, 'turns' | 'slots'>): string {
  const waiting = snapshot.turns.filter((turn) => turn.grantedAt == null).length;
  return [
    snapshot.slots.length &&
      `${snapshot.slots.length} ${snapshot.slots.length === 1 ? 'build waits' : 'builds wait'} for a slot`,
    waiting && `${waiting} ${waiting === 1 ? 'chat waits' : 'chats wait'} for a turn`,
  ]
    .filter(Boolean)
    .join(' · ');
}

const timedSchema = z.object({ conversationId: z.string(), label: z.string(), ms: z.number() });
/** Whose a program was: a chat's, a session's outside Agent Studio, or a kind of owner. */
const ownerSchema = z.union([
  z.string(),
  z.object({ chat: z.string() }),
  z.object({ session: z.string() }),
]);
/**
 * Heavy work that ran beside a measurement: another chat's command or tool call, or a program
 * the computer's readings show busy, with whose it was.
 */
const besideSchema = z.union([
  z.object({ conversationId: z.string(), label: z.string(), ms: z.number() }),
  z.object({
    owner: ownerSchema,
    name: z.string(),
    ms: z.number(),
    cpuAverage: z.number(),
    cpuPeak: z.number(),
  }),
]);
export type PcBeside = z.infer<typeof besideSchema>;
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
  /** How long it waited for a lull before it held other chats' new work. */
  lullMs: z.number().nullish(),
  /** Whether its measurement ran beside other heavy work; unknown when its window never opened. */
  contaminated: z.boolean().nullish(),
  ranBeside: list(besideSchema),
  blockers: list(timedSchema),
  others: list(timedSchema),
  /** Other chats' work in progress its window opened beside, which stayed idle. */
  idle: list(timedSchema),
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
  /** Processes other chats' programs started while the window was open, which waited for it. */
  frozen: list(
    z.object({ conversationId: z.string(), name: z.string(), processes: z.number().catch(1) }),
  ),
  machine: z
    .object({
      samples: z.number(),
      cpuAverage: z.number(),
      cpuPeak: z.number(),
      holderAverage: z.number(),
      /** The measuring chat ran in WSL, whose virtual machine counted as its own. */
      insideWsl: z.boolean().catch(false),
      othersAverage: z.number(),
      othersPeak: z.number(),
      memoryTotal: z.number(),
      memoryUsedPeak: z.number(),
      memoryAvailableLeast: z.number().nullish(),
      programs: list(
        z.object({
          name: z.string(),
          owner: ownerSchema,
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

/** A turn at a named reservation that ended, as the same history keeps it. */
export const pcTurnRecordSchema = z.object({
  kind: z.literal('turn'),
  id: z.string(),
  conversationId: z.string(),
  name: z.string(),
  landing: z.boolean().catch(false),
  purpose: z.string(),
  askedAt: z.number(),
  grantedAt: z.number().nullish(),
  endedAt: z.number(),
  endedBy: z.string(),
  waitedMs: z.number().catch(0),
  heldMs: z.number().nullish(),
  waiting: z.number().catch(0),
});
export type PcTurnRecord = z.infer<typeof pcTurnRecordSchema>;

const isTurn = (value: unknown) =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'turn';

/** The reservations of a history, newest first, leaving out what does not read as one. */
export function pcRecords(values: unknown): PcRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      if (isTurn(value)) return [];
      const parsed = pcRecordSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.endedAt - a.endedAt);
}

/** The turns of a history, newest first. */
export function pcTurnRecords(values: unknown): PcTurnRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      if (!isTurn(value)) return [];
      const parsed = pcTurnRecordSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.endedAt - a.endedAt);
}

/** How long a reservation waited for its window: until it opened, or until it ended unopened. */
export const pcWaited = (record: PcRecord) =>
  record.waitedMs ?? (record.openedAt == null ? Math.max(0, record.endedAt - record.askedAt) : 0);

/** What a history's reservations took, together. */
export function pcTotals(records: readonly PcRecord[]) {
  const totals = { count: 0, waitedMs: 0, windowMs: 0, heldMs: 0, refused: 0, contaminated: 0 };
  for (const record of records) {
    totals.count += 1;
    totals.waitedMs += pcWaited(record);
    totals.windowMs += record.windowMs ?? 0;
    totals.heldMs += record.held.ms;
    totals.refused += record.held.refused;
    if (record.contaminated) totals.contaminated += 1;
  }
  return totals;
}

/** Sessions outside Agent Studio, by the key the history names them with. */
export const pcSessions: Record<string, string> = {
  'claude-app': 'Claude app',
  'claude-cli': 'Claude Code outside Agent Studio',
  codex: 'Codex outside Agent Studio',
};

/** Whose a program was, naming a chat by its title. */
export function pcOwner(owner: PcProgram['owner'], title: (id: string) => string): string {
  if (typeof owner === 'object')
    return 'chat' in owner ? title(owner.chat) : (pcSessions[owner.session] ?? 'Another session');
  if (owner === 'app') return 'Agent Studio';
  if (owner === 'system') return 'System';
  return owner === 'wsl' ? 'WSL' : 'Yours';
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

/** What ran beside a measurement, as one line: whose it was and what. */
export function pcBesideText(beside: PcBeside, title: (id: string) => string): string {
  if ('conversationId' in beside) return `${title(beside.conversationId)} · ${beside.label}`;
  return `${pcOwner(beside.owner, title)} · ${beside.name}`;
}
