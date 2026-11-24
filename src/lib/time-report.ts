import type { ToolActivity } from './activity';
import { detached, liveField } from './detached.ts';
import type { Message } from './domain';
import { formatReplyTime } from './replies.ts';
import { toolVisual, type ToolIconKey } from './tool-presentation.ts';
import type { TimeSpent } from './time-spent.ts';

/**
 * Where the time of a reply, or of a whole chat, went (requested 2026-11-24, to learn what to
 * change so that later chats take less of it): the shares its computer measured while it ran
 * (`timeSpent`, src-tauri/src/protocol/time_spent.rs), and from the calls the reply recorded,
 * those that ran longest, those made again and again, and those the model took longest to write.
 * Derived in the window from saved data, never saved itself.
 */
export const timeKinds = [
  'commands',
  'tools',
  'agents',
  'hooks',
  'thinking',
  'writing',
  'calls',
  'waiting',
  'user',
  'background',
  'compaction',
  'startup',
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
  startup: 'Before the agent took the message',
  unrecorded: 'Replies from before this was recorded, or cut off',
};

export type TimePart = { kind: TimeKind; name: string; ms: number; share: number };

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

export type TimeReport = {
  /** The replies' recorded time, with how many replies it covers and how many recorded none. */
  ms: number;
  replies: number;
  missing: number;
  /** Largest first, kinds that took no time left out. */
  parts: TimePart[];
  requests: number;
  retries: number;
  /** By the time the calls themselves ran, longest first. */
  ran: TimedCall[];
  /** By the time the model took to write them, longest first. */
  written: TimedCall[];
};

/** Shorter than this, a group of calls is not worth a row. */
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
]);

const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function each(list: unknown, visit: (item: object) => void) {
  if (!Array.isArray(list)) return;
  const length = liveField(list, 'length') as number;
  for (let index = 0; index < length; index++) {
    const item = liveField(list, index);
    if (typeof item === 'object' && item !== null) visit(item);
  }
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
  const report: TimeReport = {
    ms: 0,
    replies: 0,
    missing: 0,
    parts: [],
    requests: 0,
    retries: 0,
    ran: [],
    written: [],
  };
  each(messages, (message) => {
    if (liveField(message, 'role') !== 'assistant' || liveField(message, 'status') === 'running')
      return;
    const duration = number(liveField(message, 'durationMs'));
    const record = liveField(message, 'timeSpent');
    const ledger = record ? (detached(record) as TimeSpent) : undefined;
    let measured = 0;
    for (const [key, value] of Object.entries(ledger?.spent ?? {})) {
      const ms = number(value);
      if (!ms) continue;
      measured += ms;
      add((timeKinds as readonly string[]).includes(key) ? (key as TimeKind) : 'other', ms);
    }
    report.requests += number(ledger?.requests) ?? 0;
    report.retries += number(ledger?.retries) ?? 0;
    if (duration == null && !measured) {
      report.missing++;
    } else {
      report.replies++;
      // A ledger cut off with its reply, or none at all, leaves time it does not explain.
      const rest = (duration ?? measured) - measured;
      if (rest >= worthARow) add('unrecorded', rest);
      report.ms += measured + (rest >= worthARow ? rest : 0);
    }
    each(liveField(message, 'blocks'), (block) => {
      const live = liveField(block, 'tool');
      if (typeof live !== 'object' || live === null) return;
      const category = liveField(live, 'category');
      if (category === 'agent' || category === 'hook' || liveField(live, 'background')) return;
      const elapsed = number(liveField(live, 'elapsedMs'));
      if (elapsed == null || liveField(live, 'status') === 'running') return;
      const tool = detached(live) as ToolActivity;
      const wrote = Math.min(number(tool.writeMs) ?? 0, elapsed);
      const visual = toolVisual(tool, { folder: options.folder });
      const key = tool.command ?? `${visual.title}\n${visual.detail ?? ''}`;
      const failed = tool.status === 'error' || tool.status === 'blocked' ? 1 : 0;
      const count = (calls: Map<string, TimedCall>, ms: number) => {
        const group = calls.get(key);
        if (group) {
          group.ms += ms;
          group.count++;
          group.failed += failed;
        } else
          calls.set(key, {
            icon: visual.icon,
            title: visual.title,
            ...(visual.code ? { code: true } : {}),
            ...(visual.detail ? { detail: visual.detail } : {}),
            ...(visual.hint ? { hint: visual.hint } : {}),
            ms,
            count: 1,
            failed,
          });
      };
      if (!waitsOnOthers.has(tool.name)) count(ran, elapsed - wrote);
      if (wrote) count(written, wrote);
    });
  });
  const longest = (calls: Map<string, TimedCall>) =>
    [...calls.values()].filter((call) => call.ms >= worthARow).sort((a, b) => b.ms - a.ms);
  report.ran = longest(ran);
  report.written = longest(written);
  report.parts = [...spent]
    .map(([kind, ms]) => ({
      kind,
      name: timeKindNames[kind],
      ms,
      share: report.ms ? ms / report.ms : 0,
    }))
    .sort(
      (a, b) =>
        // What was not recorded says the least, whatever its size.
        Number(a.kind === 'unrecorded') - Number(b.kind === 'unrecorded') || b.ms - a.ms,
    );
  return report;
}

/** Whether a report says more than its total: shares, or calls worth a row. */
export const hasTimeDetails = (report: TimeReport) =>
  report.parts.some((part) => part.kind !== 'unrecorded') ||
  report.ran.length > 0 ||
  report.written.length > 0;

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

// A table cell holds one line, and a pipe or a backtick would end the cell or the code.
const cell = (text: string) => text.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
const code = (text: string) => {
  const line = cell(text);
  const fence = '`'.repeat(Math.max(0, ...[...line.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return line
    ? `${fence}${fence.length > 1 ? ' ' : ''}${line}${fence.length > 1 ? ' ' : ''}${fence}`
    : '';
};
const callText = (call: TimedCall) =>
  call.code
    ? code(call.title)
    : [cell(call.title), call.detail ? code(call.detail) : ''].filter(Boolean).join(' ');

/**
 * The report as Markdown, to paste into a chat or a note: every share, and the calls that took
 * longest, `rows` of each, a command by the line that names it.
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
  if (report.parts.length)
    lines.push(
      '',
      '| What the reply waited on | Time | Share |',
      '| --- | ---: | ---: |',
      ...report.parts.map(
        (part) => `| ${part.name} | ${formatReplyTime(part.ms)} | ${timeShare(part.share)} |`,
      ),
    );
  const table = (heading: string, calls: TimedCall[]) => {
    if (!calls.length) return;
    lines.push(
      '',
      `## ${heading}`,
      '',
      '| Time | Calls | Call |',
      '| ---: | --- | --- |',
      ...calls
        .slice(0, rows)
        .map(
          (call) =>
            `| ${formatReplyTime(call.ms)} | ${callCount(call).join(', ') || 'once'} | ${callText(call)} |`,
        ),
    );
    if (calls.length > rows) lines.push('', `${calls.length - rows} more not listed.`);
  };
  table('Longest calls', report.ran);
  table('Longest to write', report.written);
  return lines.join('\n') + '\n';
}

export const timedCallCount = (call: TimedCall) => callCount(call).join(', ');
