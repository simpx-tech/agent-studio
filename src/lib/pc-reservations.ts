import { z } from 'zod';
import { formatBytes } from './tool-output';

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
  /** `gpu`: a measurement of GPU work alone, beside which other chats' builds and headless tests run. */
  scope: z.enum(['computer', 'gpu']).catch('computer'),
  phase: z.enum(['queued', 'lull', 'draining', 'open']),
  askedAt: z.number(),
  /** While it waits for a lull: when it holds other chats' new work if none comes. */
  holdsAt: z.number().optional(),
  openedAt: z.number().optional(),
  minutes: z.number().optional(),
  // `handOver`: a chat asked to hand over what it holds, which the window waits for; `since`,
  // when that work began keeping the window closed.
  waitingFor: z.array(
    z.object({
      conversationId: z.string(),
      label: z.string(),
      handOver: z.boolean().optional(),
      since: z.number().optional(),
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
  /** Since when the work its holder runs has used no CPU, once its holder heard it may have stalled. */
  stalledAt: z.number().optional(),
  /** Its reply ended: when it ends unless a reply of its chat takes it on. */
  keptUntil: z.number().optional(),
});
export type PcTurn = z.infer<typeof pcTurnSchema>;

/**
 * What a held turn's row adds (requested 2026-11-26): its reply ended and it waits for its chat's
 * next reply, or the work its holder runs has used no CPU and may have stalled.
 */
export function pcTurnNote(turn: PcTurn, now: number): string | undefined {
  const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (turn.keptUntil != null)
    return `its reply ended: kept for its next reply, ${minutes(turn.keptUntil - now)} left`;
  if (turn.stalledAt != null) return `its work used no CPU for ${minutes(now - turn.stalledAt)}`;
  return undefined;
}
/** What a chat's command asks of the computer: a build, a build of a few files, or a run. */
const pcWeightSchema = z.enum(['build', 'light', 'run']).catch('build');
/** A chat's build waiting for a slot beside the builds running, or its game or test run for room. */
export const pcSlotSchema = z.object({
  conversationId: z.string(),
  label: z.string(),
  weight: pcWeightSchema,
  since: z.number(),
  granted: z.boolean().optional(),
  /**
   * Why it waits, as it was last refused: `line` (builds before it), `slots` (as many builds run
   * as run at once here), `memory` (too little free beside them), `ramp` (the last build is still
   * taking its memory), `compilers` (room for two compilers) or `room` (what it needs free).
   */
  why: z.string().optional(),
  /** The free memory it needs to start, where it waits for memory. */
  need: z.number().optional(),
});
export type PcSlot = z.infer<typeof pcSlotSchema>;
/** Memory a chat's build or run was granted as it started, held until it ends. */
export const pcGrantSchema = z.object({
  conversationId: z.string(),
  weight: pcWeightSchema,
  bytes: z.number(),
  since: z.number(),
  /** The work that took it: its description and its command in backticks. */
  label: z.string().optional(),
});
export type PcGrant = z.infer<typeof pcGrantSchema>;
/** A chat waiting in pc_wait for a reservation of the computer, since when, and what it asked to run. */
export const pcWaitSchema = z.object({
  conversationId: z.string(),
  since: z.number(),
  label: z.string().optional(),
});
export type PcWait = z.infer<typeof pcWaitSchema>;
/**
 * While builds or runs wait for room: the builds running now (a chat's, or one outside Agent
 * Studio that `label` names), how many run at once here and the memory new work may start on.
 */
export const pcBuildsSchema = z.object({
  running: z
    .array(z.object({ conversationId: z.string().optional(), label: z.string() }))
    .catch([]),
  slots: z.number(),
  available: z.number().optional(),
});
export type PcBuilds = z.infer<typeof pcBuildsSchema>;
/** A chat's branch queued with pc_land: on the train running now (`riding`), or waiting for the next. */
export const pcCarSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  purpose: z.string(),
  branch: z.string(),
  sha: z.string(),
  queuedAt: z.number(),
  riding: z.boolean().optional(),
});
export type PcCar = z.infer<typeof pcCarSchema>;
/**
 * A repository's merge train (requested 2026-11-27): the branches chats queued, landed together by
 * the repository's own script with one merge, one pipeline and one push, under its landing turn.
 * Its id stands in for a chat's in turns, slots and grants.
 */
export const pcTrainSchema = z.object({
  id: z.string(),
  repository: z.string(),
  startedAt: z.number().optional(),
  cars: z.array(pcCarSchema).catch([]),
});
export type PcTrain = z.infer<typeof pcTrainSchema>;
export const pcSnapshotSchema = z.object({
  reservations: z.array(pcReservationSchema),
  turns: z.array(pcTurnSchema).catch([]),
  slots: z.array(pcSlotSchema).catch([]),
  /** Chats waiting in pc_wait for a reservation of the computer to end. */
  waiting: z.array(z.string()).catch([]),
  /** The same waits, with since when and what each chat asked to run. */
  waits: z.array(pcWaitSchema).catch([]),
  grants: z.array(pcGrantSchema).catch([]),
  trains: z.array(pcTrainSchema).catch([]),
  builds: pcBuildsSchema.optional().catch(undefined),
});
export type PcSnapshot = z.infer<typeof pcSnapshotSchema>;

/** How the id a repository's merge trains go by begins, in place of a chat's. */
const TRAIN = 'train:';
/** The name of a chat, or of a repository's merge train where its id stands for one. */
export const pcName = (conversationId: string, title: (conversationId: string) => string) =>
  conversationId.startsWith(TRAIN)
    ? `Merge train of ${conversationId.slice(TRAIN.length)}`
    : title(conversationId);

/**
 * Where a chat stands with this computer, which its row in the sidebar marks beside its running
 * time (requested 2026-11-26): it reserves the computer (`measuring` once its window opened), or
 * holds a named reservation such as a landing turn, or waits, for the computer another chat
 * reserved, a build slot, room for a game or test run, or its turn. Waiting shows before holding.
 */
export type PcChatState =
  | { kind: 'reserving'; measuring: boolean; title: string }
  | { kind: 'waiting'; title: string }
  | { kind: 'turn'; title: string };

const turnName = (turn: PcTurn) => (turn.landing ? 'the landing turn' : turn.name);

export function pcChatState(
  snapshot: PcHoldSnapshot,
  conversationId: string,
  title: (conversationId: string) => string,
): PcChatState | undefined {
  const reserved = snapshot.reservations.findIndex((r) => r.conversationId === conversationId);
  if (reserved === 0) {
    const first = snapshot.reservations[0];
    return {
      kind: 'reserving',
      measuring: first.phase === 'open',
      title: `Reserving the computer: ${first.purpose}`,
    };
  }
  const wait = pcWaitCard(snapshot, conversationId, title);
  if (wait) return { kind: 'waiting', title: [wait.heading, wait.detail].join(': ') };
  const held = snapshot.turns.find(
    (turn) => turn.conversationId === conversationId && turn.grantedAt != null,
  );
  if (held) {
    const note =
      held.keptUntil != null
        ? ': its reply ended, and it waits a few minutes for the next'
        : held.stalledAt != null
          ? ': the work it runs uses no CPU and may have stalled'
          : '';
    return { kind: 'turn', title: `Holding ${turnName(held)}${note}` };
  }
  return undefined;
}

/**
 * What a chat waits for now, in one line, which its row in the sidebar says on hover: the
 * computer another chat reserved, a place in line to reserve it, a build slot, room for a game or
 * test run, or its turn at a named reservation. `since` is when the wait began, where it is known.
 * A chat whose own reservation waits for its window reserves rather than waits.
 */
export function pcWaitCard(
  snapshot: PcHoldSnapshot,
  conversationId: string,
  chatTitle: (conversationId: string) => string,
): { heading: string; detail: string; since?: number } | undefined {
  const hold = pcHold(snapshot, conversationId, chatTitle);
  return hold && hold.kind !== 'window'
    ? { heading: hold.heading, detail: hold.detail, since: hold.since }
    : undefined;
}

/** What `pcHold` reads of a snapshot; what a page from before a field existed lacks is empty. */
export type PcHoldSnapshot = Pick<PcSnapshot, 'reservations' | 'turns' | 'slots' | 'waiting'> &
  Partial<Pick<PcSnapshot, 'trains' | 'waits' | 'grants' | 'builds'>>;

/** Work that holds a wait up: another chat's command or tool call, a build, a chat handing over. */
export type PcWork = {
  /** The chat whose work it is, or a repository's merge train; none for work outside Agent Studio. */
  conversationId?: string;
  /** What it runs: a description, then its command in backticks. */
  label: string;
  /** Since when, where known. */
  since?: number;
  /** A chat asked to hand over what it holds, rather than a command. */
  handOver?: boolean;
  /** The memory it holds, for work that was granted room. */
  bytes?: number;
};

/**
 * What a chat waits for on this computer, as the card in its running reply shows it, where its
 * wait for the computer shows (requested 2026-11-28: "render a full card in warning, with the
 * reason and what is waiting"), and who holds that up:
 * - `computer`: another chat reserved the computer to measure, and this chat waits in pc_wait;
 * - `window`: its own reservation, first in line, waits for its window to open;
 * - `line`: its own reservation waits behind another chat's;
 * - `slot`: its build waits for a build slot;
 * - `room`: its game or test run, or its build of a few files, waits for free memory;
 * - `turn`: it waits for its turn at a named reservation, such as a repository's landing turn;
 * - `train`: its branch waits for, or rides, a repository's merge train.
 */
export type PcHold = {
  kind: 'computer' | 'window' | 'line' | 'slot' | 'room' | 'turn' | 'train';
  heading: string;
  /** One line, for the sidebar. */
  detail: string;
  /** When the wait began, where known. */
  since?: number;
  /** What it waited for is free: its work goes now. */
  ready?: boolean;
  /** Whose reservation or turn it waits for, what that chat does, and since when. */
  holder?: { conversationId: string; does: string; purpose: string; since?: number };
  /** The measurement it waits for, or its own: where it stands. */
  measure?: Pick<PcReservation, 'phase' | 'openedAt' | 'minutes' | 'holdsAt' | 'scope'>;
  /** The turn its holder holds, whose note says when it may end. */
  turn?: PcTurn;
  /** Why it waits, where the work below does not say it alone. */
  reason?: string;
  /** What holds it up now, under its heading: a window's work in progress, builds, memory. */
  work: PcWork[];
  workHeading?: string;
  /**
   * Short facts, a description and command in backticks where a value names one; a `wide` one,
   * such as what the chat waits to run, takes a row of its own and wraps.
   */
  facts: { label: string; value: string; wide?: boolean }[];
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** A turn's name as a fact: the repository a landing turn lands on, or the name. */
const turnFact = (turn: PcTurn) =>
  turn.landing
    ? { label: 'Lands on', value: turn.name.replace(/^the landing of /, '') }
    : { label: 'Name', value: turn.name };
/**
 * Why a build or run of `slots` waits for room, from the reason the gate last gave it; none for a
 * slot kept for it, or one a computer from before the reason existed gave.
 */
export function pcSlotReason(
  slot: PcSlot,
  slots: readonly PcSlot[],
  builds: PcBuilds | undefined,
): string | undefined {
  if (slot.granted) return undefined;
  const need = slot.need != null ? formatBytes(slot.need) : undefined;
  const index = slots.indexOf(slot);
  const buildsAhead = slots
    .slice(0, Math.max(0, index))
    .filter((s) => s.weight === 'build' && !s.granted).length;
  switch (slot.why) {
    case 'line':
      return `${plural(buildsAhead || 1, 'build waits', 'builds wait')} ahead of it`;
    case 'slots':
      return !builds
        ? 'Every build slot is taken'
        : builds.slots === 1
          ? 'One build runs at a time here'
          : `All ${builds.slots} build slots are taken`;
    case 'memory':
      return `A build beside others needs ${need ?? 'more'} of free memory`;
    case 'ramp':
      return 'The last build started is still taking its memory';
    case 'compilers':
      return 'It waits a few minutes for memory for two compilers, then starts with what there is';
    case 'room':
      return `It needs ${need ?? 'more'} of free memory to start`;
    default:
      return undefined;
  }
}

/** What `conversationId` waits for on this computer now, with why and on whose work. */
export function pcHold(
  snapshot: PcHoldSnapshot,
  conversationId: string,
  chatTitle: (conversationId: string) => string,
): PcHold | undefined {
  const title = (id: string) => pcName(id, chatTitle);
  const [first] = snapshot.reservations;
  const line = snapshot.reservations.findIndex((r) => r.conversationId === conversationId);
  const measure = (r: PcReservation) => ({
    phase: r.phase,
    openedAt: r.openedAt,
    minutes: r.minutes,
    holdsAt: r.holdsAt,
    scope: r.scope,
  });
  // The work in progress a window that has not opened waits for.
  const windowWork = (r: PcReservation): PcWork[] =>
    r.phase === 'open'
      ? []
      : r.waitingFor.map((blocker) => ({
          conversationId: blocker.conversationId,
          label: blocker.label,
          since: blocker.since,
          handOver: blocker.handOver || undefined,
        }));
  const reserves = (r: PcReservation) =>
    r.scope === 'gpu' ? 'reserved the GPU to measure' : 'reserved the computer to measure';
  type Fact = PcHold['facts'][number];
  const facts = (...list: (Fact | false | undefined)[]) =>
    list.filter((fact): fact is Fact => !!fact);

  if (line === 0 && first.phase !== 'open') {
    const lull = first.phase === 'lull';
    const work = windowWork(first);
    return {
      kind: 'window',
      heading: lull ? 'Waiting for a lull to measure' : 'Waiting for other chats to finish',
      detail: first.purpose,
      since: first.askedAt,
      measure: measure(first),
      work,
      workHeading: work.length ? 'Its measurement waits for' : undefined,
      facts: facts(
        { label: 'To measure', value: first.purpose, wide: true },
        first.scope === 'gpu' && { label: 'Holds', value: 'GPU work only' },
        first.held > 0 && { label: 'Chats waiting', value: String(first.held) },
        snapshot.reservations.length > 1 && {
          label: 'In line after it',
          value: plural(snapshot.reservations.length - 1, 'chat', 'chats'),
        },
      ),
    };
  }
  if (line > 0) {
    const mine = snapshot.reservations[line];
    const work = windowWork(first);
    return {
      kind: 'line',
      heading: 'In line to reserve the computer',
      detail: `${line === 1 ? 'Next' : `${line} ahead`}, behind ${title(first.conversationId)}: ${first.purpose}`,
      since: mine.askedAt,
      holder: {
        conversationId: first.conversationId,
        does: reserves(first),
        purpose: first.purpose,
        since: first.openedAt ?? first.askedAt,
      },
      measure: measure(first),
      work,
      workHeading: work.length ? 'Its measurement waits for' : undefined,
      facts: facts(
        { label: 'Place', value: line === 1 ? 'Next' : `${line} ahead` },
        { label: 'To measure', value: mine.purpose, wide: true },
      ),
    };
  }
  if (first && snapshot.waiting.includes(conversationId)) {
    const wait = snapshot.waits?.find((w) => w.conversationId === conversationId);
    const others = snapshot.waiting.filter((id) => id !== conversationId).length;
    const work = windowWork(first);
    return {
      kind: 'computer',
      heading: 'Waiting for the computer',
      detail: `${title(first.conversationId)} reserved it: ${first.purpose}`,
      since: wait?.since,
      holder: {
        conversationId: first.conversationId,
        does: reserves(first),
        purpose: first.purpose,
        since: first.openedAt ?? first.askedAt,
      },
      measure: measure(first),
      work,
      workHeading: work.length ? 'Its measurement waits for' : undefined,
      facts: facts(
        !!wait?.label && { label: 'Waiting to run', value: wait.label, wide: true },
        others > 0 && { label: 'Also waiting', value: plural(others, 'chat', 'chats') },
        snapshot.reservations.length > 1 && {
          label: 'In line after it',
          value: plural(snapshot.reservations.length - 1, 'chat', 'chats'),
        },
      ),
    };
  }
  const slot = snapshot.slots.find((s) => s.conversationId === conversationId);
  if (slot) {
    const run = slot.weight === 'run';
    const room = run || slot.weight === 'light';
    const ahead = snapshot.slots.findIndex((s) => s === slot);
    const builds = snapshot.builds;
    // A build waits for the builds running; work short of memory for what holds it.
    const memory = room || slot.why === 'memory' || slot.why === 'compilers';
    const work: PcWork[] = slot.granted
      ? []
      : memory
        ? (snapshot.grants ?? [])
            .filter((grant) => grant.conversationId !== conversationId)
            .map((grant) => ({
              conversationId: grant.conversationId,
              label:
                grant.label ??
                { build: 'A build', light: 'A build of a few files', run: 'A game or test run' }[
                  grant.weight
                ],
              since: grant.since,
              bytes: grant.bytes,
            }))
        : (builds?.running ?? []).map((build) => ({
            conversationId: build.conversationId,
            label: build.label,
          }));
    return {
      kind: room ? 'room' : 'slot',
      heading: slot.granted
        ? run
          ? 'Room for its run is free'
          : 'A build slot is free'
        : run
          ? 'Waiting for room for a game or test run'
          : room
            ? 'Waiting for room for a build of a few files'
            : 'Waiting for a build slot',
      detail: [
        ahead > 0 ? `${ahead} ahead in line` : 'First in line',
        slot.label.replace(/`/g, ''),
      ].join(' · '),
      since: slot.since,
      ready: slot.granted || undefined,
      reason: slot.granted
        ? 'Kept for it for two minutes'
        : pcSlotReason(slot, snapshot.slots, builds),
      work,
      workHeading: work.length ? (memory ? 'Memory held by' : 'Builds running') : undefined,
      facts: facts(
        { label: slot.granted ? 'Runs' : 'Waiting to run', value: slot.label, wide: true },
        !slot.granted && { label: 'Place', value: ahead > 0 ? `${ahead} ahead` : 'First' },
        !slot.granted &&
          memory &&
          builds?.available != null && {
            label: 'Free now',
            value: formatBytes(builds.available),
          },
      ),
    };
  }
  const turn = snapshot.turns.find(
    (t) => t.conversationId === conversationId && t.grantedAt == null,
  );
  if (turn) {
    const key = (t: PcTurn) => (t.landing ? `landing:${t.name}` : t.name.toLowerCase());
    const same = snapshot.turns.filter((t) => key(t) === key(turn));
    const holder = same.find((t) => t.grantedAt != null);
    const ahead = same.filter((t) => t.grantedAt == null).indexOf(turn);
    return {
      kind: 'turn',
      heading: 'Waiting for its turn',
      detail: holder
        ? `${title(holder.conversationId)} holds ${turnName(turn)}: ${holder.purpose}`
        : `${turnName(turn)}`,
      since: turn.askedAt,
      holder: holder && {
        conversationId: holder.conversationId,
        does: `holds ${turnName(turn)}`,
        purpose: holder.purpose,
        since: holder.grantedAt,
      },
      turn: holder,
      work: [],
      facts: facts(
        turnFact(turn),
        { label: 'Place', value: ahead > 0 ? `${ahead} ahead` : 'Next' },
        !!turn.purpose && { label: 'For', value: turn.purpose, wide: true },
      ),
    };
  }
  for (const train of snapshot.trains ?? []) {
    const car = train.cars.find((c) => c.conversationId === conversationId);
    if (!car) continue;
    const riding = train.cars.filter((c) => c.riding);
    const ahead = train.cars.filter((c) => !c.riding).indexOf(car);
    const place = car.riding
      ? `${riding.length} on the train`
      : ahead > 0
        ? `${ahead} ahead in line`
        : train.startedAt != null
          ? 'Next, after the train running now'
          : 'Next';
    return {
      kind: 'train',
      heading: car.riding ? 'Landing on the merge train' : 'Waiting for the merge train',
      detail: [place, car.branch, train.repository].join(' · '),
      since: car.riding ? (train.startedAt ?? car.queuedAt) : car.queuedAt,
      reason: car.riding
        ? "The repository's own script merges, checks and pushes the branches on the train"
        : train.startedAt != null
          ? 'A train is landing other branches now'
          : 'The train waits for the landing turn and a build slot',
      work: car.riding
        ? []
        : riding.map((other) => ({
            conversationId: other.conversationId,
            label: `\`${other.branch}\` · ${other.purpose}`,
            since: train.startedAt,
          })),
      workHeading: !car.riding && riding.length ? 'On the train now' : undefined,
      facts: facts(
        { label: 'Branch', value: `\`${car.branch}\`` },
        { label: 'Repository', value: train.repository },
        { label: 'Place', value: place },
      ),
    };
  }
  return undefined;
}

/** Named reservations by name, each with its holder first, in the order they were asked for. */
export function pcTurnGroups(turns: readonly PcTurn[]): { name: string; turns: PcTurn[] }[] {
  const groups = new Map<string, PcTurn[]>();
  for (const turn of turns) {
    const key = turn.landing ? `landing:${turn.name}` : turn.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), turn]);
  }
  return [...groups.values()].map((list) => ({ name: list[0].name, turns: list }));
}

/**
 * Whether anything waits or lands on this computer: a reservation, a build for a slot, a turn, or
 * a merge train.
 */
export const pcBusy = (
  snapshot: Pick<PcSnapshot, 'reservations' | 'turns' | 'slots'> &
    Partial<Pick<PcSnapshot, 'trains'>>,
) =>
  snapshot.reservations.length > 0 ||
  snapshot.slots.length > 0 ||
  snapshot.turns.some((turn) => turn.grantedAt == null) ||
  (snapshot.trains ?? []).some((train) => train.cars.length > 0);

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

/** The hover text of the indicator while builds wait for a slot, chats for a turn or branches land. */
export function pcQueueTitle(
  snapshot: Pick<PcSnapshot, 'turns' | 'slots'> & Partial<Pick<PcSnapshot, 'trains'>>,
): string {
  const waiting = snapshot.turns.filter((turn) => turn.grantedAt == null).length;
  const cars = (snapshot.trains ?? []).flatMap((train) => train.cars);
  const riding = cars.filter((car) => car.riding).length;
  return [
    snapshot.slots.length &&
      `${snapshot.slots.length} ${snapshot.slots.length === 1 ? 'build waits' : 'builds wait'} for a slot`,
    waiting && `${waiting} ${waiting === 1 ? 'chat waits' : 'chats wait'} for a turn`,
    riding && `${riding} ${riding === 1 ? 'branch lands' : 'branches land'} on a merge train`,
    cars.length - riding &&
      `${cars.length - riding} ${cars.length - riding === 1 ? 'branch waits' : 'branches wait'} for a merge train`,
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

/** The kind of a history's record: `turn`, `wait` (for a slot) or `train`; none for a reservation. */
const kindOf = (value: unknown) =>
  typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
const isTurn = (value: unknown) => kindOf(value) === 'turn';

/** The reservations of a history, newest first, leaving out what does not read as one. */
export function pcRecords(values: unknown): PcRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      // Turns, waits for a slot and merge trains are records of their own kinds.
      if (kindOf(value) != null) return [];
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

/** How a turn the history keeps ended, where it did not end by its release. */
export const pcTurnEnd = (record: PcTurnRecord): string | undefined =>
  (
    ({
      reply: 'its reply ended',
      stalled: 'its work used no CPU',
      closed: 'its chat was closed',
      train: 'a merge train took it over',
    }) as Record<string, string>
  )[record.endedBy];

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
