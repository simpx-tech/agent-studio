import type { ToolActivity } from './activity';
import { detached, liveField } from './detached.ts';
import type { Message } from './domain';
import { formatReplyTime } from './replies.ts';
import {
  commandKind,
  toolVisual,
  type CommandKind,
  type ToolIconKey,
} from './tool-presentation.ts';
import type { TimeSpent } from './time-spent.ts';

/**
 * Where the time of a reply, or of a whole chat, went (requested 2026-11-24, to learn what to
 * change so that later chats take less of it): the shares its computer measured while it ran
 * (`timeSpent`, src-tauri/src/protocol/time_spent.rs), the same as a timeline, what each step of
 * the reply's plan and each stretch between its notes took and was made of, its sub-agents, and
 * from the calls the reply recorded, those that ran longest, the kinds of command they were, and
 * those the model took longest to write. Derived in the window from saved data, never saved.
 */
export const timeKinds = [
  'waiting',
  'thinking',
  'writing',
  'calls',
  'commands',
  'tools',
  'agents',
  'hooks',
  'user',
  'background',
  'held',
  'slot',
  'turn',
  'startup',
  'compaction',
  'other',
  'unrecorded',
] as const;
export type TimeKind = (typeof timeKinds)[number];

export const timeKindNames: Record<TimeKind, string> = {
  commands: 'Commands',
  tools: 'Tools',
  agents: 'Sub-agents',
  hooks: 'Hooks',
  thinking: 'Thinking',
  writing: 'Writing',
  calls: 'Writing calls',
  waiting: 'Waiting for the model',
  user: 'Waiting for you',
  background: 'Background work',
  held: 'Waiting for the computer',
  slot: 'Waiting for a build slot',
  turn: 'Waiting for its turn',
  compaction: 'Compacting',
  startup: 'Starting',
  other: 'Other',
  unrecorded: 'Not recorded',
};

/** What a name alone does not say, for hover. */
export const timeKindHints: Partial<Record<TimeKind, string>> = {
  calls: 'The model writing commands, file contents and other calls',
  waiting: 'From each request until its answer began',
  background: 'The reply waited for work it left running',
  held: 'Another chat had the computer reserved for a measurement',
  slot: 'The builds running left no room for its build',
  turn: 'Another chat held what it reserved, such as its repository’s landing',
  startup: 'Before the agent took the message',
  unrecorded: 'Replies from before this was recorded, or cut off',
};

/**
 * Kinds that belong together, by who spent the time. A chart shows these four, and a fifth for
 * what was not recorded.
 */
export const timeFamilies = ['model', 'work', 'hold', 'overhead', 'unknown'] as const;
export type TimeFamily = (typeof timeFamilies)[number];
export const timeFamilyNames: Record<TimeFamily, string> = {
  model: 'Model',
  work: 'Commands and tools',
  hold: 'On hold',
  overhead: 'Overhead',
  unknown: 'Not recorded',
};
export const kindFamily: Record<TimeKind, TimeFamily> = {
  waiting: 'model',
  thinking: 'model',
  writing: 'model',
  calls: 'model',
  commands: 'work',
  tools: 'work',
  agents: 'work',
  hooks: 'work',
  user: 'hold',
  background: 'hold',
  held: 'hold',
  slot: 'hold',
  turn: 'hold',
  startup: 'overhead',
  compaction: 'overhead',
  other: 'overhead',
  unrecorded: 'unknown',
};

export type TimePart = {
  kind: TimeKind;
  family: TimeFamily;
  name: string;
  ms: number;
  share: number;
};
/** What a stretch of time was made of, by family, in the families' order. */
export type Makeup = { family: TimeFamily; name: string; ms: number; share: number }[];

/** Calls that did the same thing, together. */
export type TimedCall = {
  icon: ToolIconKey;
  title: string;
  /** Shown as code: the title of a command, or the detail of another call. */
  code?: boolean;
  detail?: string;
  hint?: string;
  ms: number;
  count: number;
  failed: number;
};

/** A stretch of a reply's timeline. */
export type TimeSlice = { kind: TimeKind; family: TimeFamily; start: number; ms: number };
/** Something that ran from `start` for `ms` in a reply, to draw under its timeline. */
export type TimeSpan = { title: string; start: number; ms: number };

/** A step of a reply's plan, or the stretch a note of the model's began. */
export type TimeStep = {
  title: string;
  ms: number;
  share: number;
  makeup: Makeup;
  /** Milliseconds into its reply when it first began. */
  start: number;
  /** How many times it was taken up: a plan step can be left and returned to. */
  stretches: number;
  /** Which of the report's replies it belongs to, counted from one. */
  reply: number;
  /** Time no step or note covers: before the first, or while no step was in progress. */
  rest?: boolean;
};

export type TimedAgent = {
  name: string;
  task?: string;
  /** Unknown for one that still runs, or that ran before this was recorded. */
  ms?: number;
  start?: number;
  status: string;
  background: boolean;
  calls: number;
  failed: number;
  /** Its own calls, and the rest, which is its model. */
  makeup: Makeup;
  reply: number;
};

export type CommandGroup = { icon: CommandKind; name: string; ms: number; count: number };

export type ReplyTime = { id: string; label: string; ms: number; makeup: Makeup };

/**
 * A measurement a reply made with the computer reserved, from its release's record: whether it
 * ran beside other heavy work, and what that was (src-tauri/src/reservations.rs).
 */
export type TimedMeasurement = { reply: number; clean: boolean; beside?: string };

export type TimeReport = {
  /** The replies' recorded time, with how many replies it covers and how many recorded none. */
  ms: number;
  replies: number;
  missing: number;
  /** By kind, largest first, kinds that took no time left out. */
  parts: TimePart[];
  /** The same by family, in the families' own order. */
  families: Makeup;
  requests: number;
  retries: number;
  /** The plan's steps in the order they began, then what no step covered. */
  steps: TimeStep[];
  /** The stretches between the model's notes, in order. */
  notes: TimeStep[];
  agents: TimedAgent[];
  /** Commands by what they did, longest first. */
  commands: CommandGroup[];
  /** By the time the calls themselves ran, longest first. */
  ran: TimedCall[];
  /** By the time the model took to write them, longest first. */
  written: TimedCall[];
  /** Each reply the report covers, in order. */
  list: ReplyTime[];
  /** The measurements its replies made with the computer reserved, in order. */
  measurements: TimedMeasurement[];
  /** Of a report on one reply that recorded it: its time in order, with what ran under it. */
  timeline?: TimeSlice[];
  stepSpans?: TimeSpan[];
  agentSpans?: TimeSpan[];
};

/** Shorter than this, a group of calls or a stretch is not worth a row. */
const worthARow = 1000;

// Calls that wait for someone: their time is the user's or the background work's.
const waitsOnOthers = new Set([
  'AskUserQuestion',
  'studio_ask_user',
  'mcp__agent_studio__studio_ask_user',
  'EnterPlanMode',
  'ExitPlanMode',
  'Wait for background tasks',
  'await_background_tasks',
  'mcp__agent_studio__await_background_tasks',
  'Wait for the computer',
]);

const commandNames: Record<CommandKind, string> = {
  test: 'Tests',
  build: 'Builds and checks',
  lint: 'Lint and format',
  git: 'Git',
  pullRequest: 'Pull requests',
  package: 'Packages',
  server: 'Servers',
  script: 'Scripts',
  container: 'Containers',
  network: 'Network',
  remote: 'Remote computers',
  list: 'Listing files',
  read: 'Reading files',
  search: 'Searching',
  delete: 'Deleting',
  create: 'Creating',
  move: 'Moving',
  process: 'Processes',
  wait: 'Waiting',
  write: 'Writing files',
  agentCli: 'Agent CLIs',
  terminal: 'Other commands',
};

const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const kindOf = (key: string): TimeKind =>
  (timeKinds as readonly string[]).includes(key) ? (key as TimeKind) : 'other';

function each(list: unknown, visit: (item: object, index: number) => void) {
  if (!Array.isArray(list)) return;
  const length = liveField(list, 'length') as number;
  for (let index = 0; index < length; index++) {
    const item = liveField(list, index);
    if (typeof item === 'object' && item !== null) visit(item, index);
  }
}

/** The make-up of time counted by family, in the families' order. */
function makeupOf(ms: Map<TimeFamily, number>): Makeup {
  const total = [...ms.values()].reduce((sum, value) => sum + value, 0);
  return timeFamilies
    .filter((family) => (ms.get(family) ?? 0) > 0)
    .map((family) => ({
      family,
      name: timeFamilyNames[family],
      ms: ms.get(family)!,
      share: total ? ms.get(family)! / total : 0,
    }));
}

/** A note's first line as a label, without the Markdown marks around it. */
function noteLabel(note: string): string {
  const line = note.split(/\r?\n/).find((candidate) => candidate.trim()) ?? '';
  return line
    .trim()
    .replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/** How much the stretches `intervals` cover, each moment counted once where they overlap. */
function covered(intervals: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/**
 * The report of `messages`: one reply, or a chat's. A running reply is left out, as it is of the
 * chat's total time. Messages are read without making them reactive (src/lib/detached.ts), since
 * a chat's report reads every call the chat made.
 */
export function timeReport(messages: readonly Message[], options: { folder?: string } = {}) {
  const spent = new Map<TimeKind, number>();
  const add = (kind: TimeKind, ms: number) => spent.set(kind, (spent.get(kind) ?? 0) + ms);
  const ran = new Map<string, TimedCall>();
  const written = new Map<string, TimedCall>();
  const commands = new Map<CommandKind, CommandGroup>();
  const report: TimeReport = {
    ms: 0,
    replies: 0,
    missing: 0,
    parts: [],
    families: [],
    requests: 0,
    retries: 0,
    steps: [],
    notes: [],
    agents: [],
    commands: [],
    ran: [],
    written: [],
    list: [],
    measurements: [],
  };
  let single: Pick<TimeReport, 'timeline' | 'stepSpans' | 'agentSpans'> = {};
  // What the user asked last names the reply that answers it.
  let asked = '';
  each(messages, (message) => {
    if (liveField(message, 'role') === 'user') {
      let first = '';
      each(liveField(message, 'blocks'), (block) => {
        if (!first && liveField(block, 'type') === 'markdown')
          first = noteLabel(text(liveField(block, 'text')) ?? '');
      });
      asked = first;
      return;
    }
    if (liveField(message, 'role') !== 'assistant' || liveField(message, 'status') === 'running')
      return;
    const duration = number(liveField(message, 'durationMs'));
    const record = liveField(message, 'timeSpent');
    const ledger = record ? (detached(record) as TimeSpent) : undefined;
    let measured = 0;
    const own = new Map<TimeFamily, number>();
    const count = (kind: TimeKind, ms: number) => {
      add(kind, ms);
      own.set(kindFamily[kind], (own.get(kindFamily[kind]) ?? 0) + ms);
    };
    for (const [key, value] of Object.entries(ledger?.spent ?? {})) {
      const ms = number(value);
      if (!ms) continue;
      measured += ms;
      count(kindOf(key), ms);
    }
    report.requests += number(ledger?.requests) ?? 0;
    report.retries += number(ledger?.retries) ?? 0;
    if (duration == null && !measured) {
      report.missing++;
      return;
    }
    report.replies++;
    const reply = report.replies;
    // A ledger cut off with its reply, or none at all, leaves time it does not explain.
    const rest = (duration ?? measured) - measured;
    const unexplained = rest >= worthARow ? rest : 0;
    if (unexplained) count('unrecorded', unexplained);
    const total = measured + unexplained;
    report.ms += total;
    report.list.push({
      id: text(liveField(message, 'id')) ?? String(reply),
      label: asked || `Reply ${reply}`,
      ms: total,
      makeup: makeupOf(own),
    });

    // The reply's time in order, which says what any stretch of it was made of.
    const slices: TimeSlice[] = [];
    const runs = ledger?.timeline?.runs ?? [];
    let passed = 0;
    for (let index = 0; index + 1 < runs.length; index += 2) {
      const ms = number(runs[index + 1]);
      if (!ms) continue;
      const kind = kindOf(ledger!.timeline!.kinds[runs[index]] ?? '');
      slices.push({ kind, family: kindFamily[kind], start: passed, ms });
      passed += ms;
    }
    if (slices.length && total - passed >= worthARow)
      slices.push({ kind: 'unrecorded', family: 'unknown', start: passed, ms: total - passed });
    const length = slices.length ? Math.max(passed, total) : total;
    const between = (from: number, to: number) => {
      const made = new Map<TimeFamily, number>();
      for (const slice of slices) {
        const overlap = Math.min(to, slice.start + slice.ms) - Math.max(from, slice.start);
        if (overlap > 0) made.set(slice.family, (made.get(slice.family) ?? 0) + overlap);
      }
      return made;
    };
    // Each mark holds until the next one, the last until the reply's end.
    const stretches = <T extends { at: number }>(marks: T[] | undefined) =>
      (marks ?? []).map((mark, index, all) => ({
        mark,
        from: Math.min(mark.at, length),
        to: Math.min(all[index + 1]?.at ?? length, length),
      }));

    const steps = new Map<string, TimeStep & { made: Map<TimeFamily, number> }>();
    const stepSpans: TimeSpan[] = [];
    let planned = 0;
    for (const { mark, from, to } of stretches(ledger?.steps)) {
      if (!mark.title || to <= from) continue;
      planned += to - from;
      stepSpans.push({ title: mark.title, start: from, ms: to - from });
      let step = steps.get(mark.title);
      if (!step) {
        step = {
          title: mark.title,
          ms: 0,
          share: 0,
          makeup: [],
          start: from,
          stretches: 0,
          reply,
          made: new Map(),
        };
        steps.set(mark.title, step);
      }
      step.ms += to - from;
      step.stretches++;
      for (const [family, ms] of between(from, to))
        step.made.set(family, (step.made.get(family) ?? 0) + ms);
    }
    // What no step covered is the reply's time less the steps'.
    const outside = between(0, length);
    for (const { made, ...step } of steps.values()) {
      report.steps.push({ ...step, makeup: makeupOf(made) });
      for (const [family, ms] of made) outside.set(family, (outside.get(family) ?? 0) - ms);
    }
    if (steps.size && length - planned >= worthARow)
      report.steps.push({
        title: 'Outside the plan',
        ms: length - planned,
        share: 0,
        makeup: makeupOf(outside),
        start: 0,
        stretches: 1,
        reply,
        rest: true,
      });

    // Calls, sub-agents and the notes' own words, from what the reply recorded.
    const labels = new Map<string, string>();
    const children = new Map<string, { run: [number, number] | number; failed: boolean }[]>();
    const agents: (Omit<TimedAgent, 'makeup' | 'calls' | 'failed' | 'reply'> & { id: string })[] =
      [];
    each(liveField(message, 'blocks'), (block) => {
      const progress = liveField(block, 'progress');
      if (typeof progress === 'object' && progress !== null) {
        const id = text(liveField(progress, 'id'));
        if (id) labels.set(id, noteLabel(text(liveField(block, 'text')) ?? ''));
        return;
      }
      const live = liveField(block, 'tool');
      if (typeof live !== 'object' || live === null) return;
      // A release says whether its measurement ran beside other heavy work.
      if (liveField(live, 'name') === 'Release the computer') {
        const facts = (detached(liveField(live, 'facts')) ?? []) as {
          label: string;
          value: string;
        }[];
        const verdict = facts.find((fact) => fact.label === 'Measurement')?.value;
        const beside = facts.find((fact) => fact.label === 'Ran beside')?.value;
        if (verdict)
          report.measurements.push({
            reply,
            clean: verdict === 'Clean',
            ...(beside ? { beside } : {}),
          });
      }
      const category = liveField(live, 'category');
      if (category === 'agent') {
        // A group's sub-agents, read field by field: their messages can be long.
        each(liveField(live, 'agents'), (agent) => {
          const id = text(liveField(agent, 'id'));
          if (!id || text(liveField(agent, 'parentId'))) return;
          const ms = number(liveField(agent, 'elapsedMs'));
          const start = number(liveField(agent, 'startMs'));
          const task = text(liveField(agent, 'task'));
          agents.push({
            id,
            name: text(liveField(agent, 'name')) ?? 'Sub-agent',
            ...(task ? { task } : {}),
            ...(ms != null ? { ms } : {}),
            ...(start != null ? { start } : {}),
            status: text(liveField(agent, 'status')) ?? 'unknown',
            background: liveField(agent, 'background') === true,
          });
        });
        return;
      }
      if (category === 'hook' || liveField(live, 'background')) return;
      const elapsed = number(liveField(live, 'elapsedMs'));
      if (elapsed == null || liveField(live, 'status') === 'running') return;
      const tool = detached(live) as ToolActivity;
      const wrote = Math.min(number(tool.writeMs) ?? 0, elapsed);
      const failed = tool.status === 'error' || tool.status === 'blocked';
      const waits = waitsOnOthers.has(tool.name);
      if (tool.parentId && !waits) {
        const start = number(tool.startMs);
        const calls = children.get(tool.parentId) ?? [];
        calls.push({
          run: start == null ? elapsed - wrote : [start + wrote, start + elapsed],
          failed,
        });
        children.set(tool.parentId, calls);
      }
      const visual = toolVisual(tool, { folder: options.folder });
      const key = tool.command ?? `${visual.title}\n${visual.detail ?? ''}`;
      const group = (calls: Map<string, TimedCall>, ms: number) => {
        const same = calls.get(key);
        if (same) {
          same.ms += ms;
          same.count++;
          same.failed += Number(failed);
        } else
          calls.set(key, {
            icon: visual.icon,
            title: visual.title,
            ...(visual.code ? { code: true } : {}),
            ...(visual.detail ? { detail: visual.detail } : {}),
            ...(visual.hint ? { hint: visual.hint } : {}),
            ms,
            count: 1,
            failed: Number(failed),
          });
      };
      if (!waits) group(ran, elapsed - wrote);
      if (wrote) group(written, wrote);
      if (tool.command && !waits) {
        const icon = commandKind(tool.command);
        const same = commands.get(icon);
        if (same) {
          same.ms += elapsed - wrote;
          same.count++;
        } else
          commands.set(icon, { icon, name: commandNames[icon], ms: elapsed - wrote, count: 1 });
      }
    });

    const notes = stretches(ledger?.notes);
    if (notes.length && notes[0].from >= worthARow)
      report.notes.push({
        title: 'Before the first note',
        ms: notes[0].from,
        share: 0,
        makeup: makeupOf(between(0, notes[0].from)),
        start: 0,
        stretches: 1,
        reply,
        rest: true,
      });
    for (const { mark, from, to } of notes)
      if (to > from)
        report.notes.push({
          title: labels.get(mark.id) || 'Note',
          ms: to - from,
          share: 0,
          makeup: makeupOf(between(from, to)),
          start: from,
          stretches: 1,
          reply,
        });

    const agentSpans: TimeSpan[] = [];
    for (const { id, ...agent } of agents) {
      const calls = children.get(id) ?? [];
      const exact = calls.flatMap((call) => (Array.isArray(call.run) ? [call.run] : []));
      const loose = calls.reduce((sum, call) => sum + (Array.isArray(call.run) ? 0 : call.run), 0);
      const work = Math.min(covered(exact) + loose, agent.ms ?? Infinity);
      const made = new Map<TimeFamily, number>([['work', work]]);
      if (agent.ms != null) made.set('model', agent.ms - work);
      report.agents.push({
        ...agent,
        calls: calls.length,
        failed: calls.filter((call) => call.failed).length,
        makeup: makeupOf(made),
        reply,
      });
      if (agent.ms && agent.start != null)
        agentSpans.push({ title: agent.name, start: agent.start, ms: agent.ms });
    }
    single = slices.length ? { timeline: slices, stepSpans, agentSpans } : {};
  });
  if (report.replies === 1) Object.assign(report, single);
  const longest = <T extends { ms: number }>(groups: Iterable<T>) =>
    [...groups].filter((group) => group.ms >= worthARow).sort((a, b) => b.ms - a.ms);
  report.ran = longest(ran.values());
  report.written = longest(written.values());
  report.commands = longest(commands.values());
  // Sub-agents by how long they ran, those whose time is unknown last.
  report.agents.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));
  const share = (ms: number) => (report.ms ? ms / report.ms : 0);
  for (const step of [...report.steps, ...report.notes]) step.share = share(step.ms);
  report.parts = [...spent]
    .map(([kind, ms]) => ({
      kind,
      family: kindFamily[kind],
      name: timeKindNames[kind],
      ms,
      share: share(ms),
    }))
    .sort(
      (a, b) =>
        // What was not recorded says the least, whatever its size.
        Number(a.kind === 'unrecorded') - Number(b.kind === 'unrecorded') || b.ms - a.ms,
    );
  const families = new Map<TimeFamily, number>();
  for (const part of report.parts)
    families.set(part.family, (families.get(part.family) ?? 0) + part.ms);
  report.families = makeupOf(families);
  return report;
}

/** Whether a report says more than its total: shares, calls worth a row, or sub-agents. */
export const hasTimeDetails = (report: TimeReport) =>
  report.parts.some((part) => part.kind !== 'unrecorded') ||
  report.ran.length > 0 ||
  report.written.length > 0 ||
  report.agents.length > 0 ||
  report.measurements.length > 0;

/** How many of a report's measurements ran beside other heavy work, as words. */
export function measurementsText(measurements: readonly TimedMeasurement[]): string {
  const beside = measurements.filter((m) => !m.clean).length;
  const count = `${measurements.length} ${measurements.length === 1 ? 'measurement' : 'measurements'}`;
  return beside ? `${count}, ${beside} beside other heavy work` : `${count}, all clean`;
}

export function timeShare(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

export const requestsText = ({ requests, retries }: Pick<TimeReport, 'requests' | 'retries'>) =>
  `${requests.toLocaleString('en-US')} model ${requests === 1 ? 'request' : 'requests'}` +
  (retries ? `, ${retries.toLocaleString('en-US')} retried` : '');

const callCount = (call: TimedCall) =>
  [call.count > 1 ? `${call.count} times` : '', call.failed ? `${call.failed} failed` : ''].filter(
    Boolean,
  );
export const timedCallCount = (call: TimedCall) => callCount(call).join(', ');

/** A make-up in words: Model 62%, Commands and tools 38%. */
export const makeupText = (makeup: Makeup) =>
  makeup.map((part) => `${part.name} ${timeShare(part.share)}`).join(', ');

/** How a sub-agent ended, in a word, for one that did not simply finish. */
export const agentOutcome = (agent: Pick<TimedAgent, 'status' | 'background'>): string =>
  ({
    running: agent.background ? 'In background' : 'Running',
    error: 'Failed',
    blocked: 'Blocked',
    cancelled: 'Stopped',
    unknown: 'Unconfirmed',
  })[agent.status] ?? '';

// A table cell holds one line, and a pipe or a backtick would end the cell or the code.
const cell = (line: string) => line.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
const code = (value: string) => {
  const line = cell(value);
  const fence = '`'.repeat(Math.max(0, ...[...line.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = fence.length > 1 ? ' ' : '';
  return line ? `${fence}${pad}${line}${pad}${fence}` : '';
};
const callText = (call: TimedCall) =>
  call.code
    ? code(call.title)
    : [cell(call.title), call.detail ? code(call.detail) : ''].filter(Boolean).join(' ');

/**
 * The report as Markdown, to paste into a chat or a note: every share, the steps, the sub-agents,
 * the kinds of command, and the calls that took longest, `rows` of each list, a command by the
 * line that names it.
 */
export function timeReportMarkdown(
  report: TimeReport,
  { title, scope, rows = 20 }: { title: string; scope: string; rows?: number },
): string {
  const lines = [
    `# Time report: ${cell(title)}`,
    '',
    `${scope}, ${formatReplyTime(report.ms)}` +
      (report.replies > 1 ? ` over ${report.replies} replies` : '') +
      (report.requests ? `, ${requestsText(report)}` : '') +
      (report.missing
        ? `. ${report.missing} ${report.missing === 1 ? 'reply' : 'replies'} recorded no time`
        : '') +
      '.',
  ];
  const table = <T>(heading: string, columns: string[], items: T[], row: (item: T) => string[]) => {
    if (!items.length) return;
    // Numbers read from the right, names from the left.
    const numeric = (column: string) => ['Time', 'Share', 'Calls'].includes(column);
    lines.push(
      '',
      ...(heading ? [`## ${heading}`, ''] : []),
      `| ${columns.join(' | ')} |`,
      `| ${columns.map((column) => (numeric(column) ? '---:' : '---')).join(' | ')} |`,
      ...items.slice(0, rows).map((item) => `| ${row(item).join(' | ')} |`),
    );
    if (items.length > rows) lines.push('', `${items.length - rows} more not listed.`);
  };
  const time = (item: { ms: number }) => formatReplyTime(item.ms);
  table('', ['What the reply waited on', 'Time', 'Share'], report.parts, (part) => [
    part.name,
    time(part),
    timeShare(part.share),
  ]);
  const several = report.replies > 1;
  const stepRow = (step: TimeStep) => [
    cell(step.title) + (several ? ` (reply ${step.reply})` : ''),
    time(step),
    timeShare(step.share),
    makeupText(step.makeup),
  ];
  table('Plan steps', ['Step', 'Time', 'Share', 'Made of'], report.steps, stepRow);
  table(
    'Stretches by note',
    ['Began with', 'Time', 'Share', 'Made of'],
    [...report.notes].sort((a, b) => b.ms - a.ms),
    stepRow,
  );
  table('Sub-agents', ['Sub-agent', 'Time', 'Calls', 'Made of'], report.agents, (agent) => [
    [cell(agent.name), agentOutcome(agent)].filter(Boolean).join(', '),
    agent.ms == null ? 'not recorded' : formatReplyTime(agent.ms),
    String(agent.calls) + (agent.failed ? `, ${agent.failed} failed` : ''),
    makeupText(agent.makeup),
  ]);
  table('Measurements', ['Measurement', 'Ran beside'], report.measurements, (measurement) => [
    (measurement.clean ? 'Clean' : 'Beside other heavy work') +
      (several ? ` (reply ${measurement.reply})` : ''),
    cell((measurement.beside ?? '').replaceAll('\n', '; ')),
  ]);
  table('Commands by kind', ['Kind', 'Time', 'Calls'], report.commands, (group) => [
    group.name,
    time(group),
    String(group.count),
  ]);
  const calls = (call: TimedCall) => [
    time(call),
    callCount(call).join(', ') || 'once',
    callText(call),
  ];
  table('Longest calls', ['Time', 'Times', 'Call'], report.ran, calls);
  table('Longest to write', ['Time', 'Times', 'Call'], report.written, calls);
  if (several)
    table('Replies', ['Reply', 'Time', 'Made of'], report.list, (reply) => [
      cell(reply.label),
      time(reply),
      makeupText(reply.makeup),
    ]);
  return lines.join('\n') + '\n';
}

/** A moment of a reply as a timeline names it: 45s, 12m, 1h 5m. */
export function timeMark(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
}

// Round steps of time, from a second to a day.
const tickSteps = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400,
];

/** Where a timeline of `total` milliseconds marks the time: at most `most` round moments. */
export function timeTicks(total: number, most = 6): number[] {
  if (!(total > 0)) return [];
  const step =
    (tickSteps.find((seconds) => total / (seconds * 1000) <= most) ??
      Math.ceil(total / most / 86_400_000) * 86400) * 1000;
  const ticks = [];
  // A mark too near the end has no room for its name.
  for (let at = 0; at <= total * 0.93; at += step) ticks.push(at);
  return ticks;
}
