import { describe, expect, it } from 'vitest';
import { applyRunEvent, retainRunEvent, type ToolActivity } from './activity';
import {
  initialWorkspace,
  messageSchema,
  settingsFor,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, mergeShared } from './sync';
import { latestTimeSpent, type TimeSpent } from './time-spent';
import { hasTimeDetails, timeReport, timeReportMarkdown, timeShare } from './time-report';

const runId = '11111111-1111-4111-8111-111111111111';
const spent = (revision: number, parts: Record<string, number>, run = runId): TimeSpent => ({
  version: 1,
  revision,
  runId: run,
  spent: parts,
});
type Call = ToolActivity & { facts: NonNullable<ToolActivity['facts']> };
const call = (id: string, fields: Partial<ToolActivity>): Call => ({
  id,
  revision: 1,
  category: 'tool',
  name: 'Bash',
  status: 'complete',
  facts: [],
  sources: [],
  agents: [],
  ...fields,
});
const reply = (fields: Partial<Message> = {}, calls: Call[] = []): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'complete',
  createdAt: '',
  runId,
  blocks: calls.map((tool, order) => ({ type: 'activity', text: tool.name, tool, order })),
  ...fields,
});

describe('time report', () => {
  it('shares a reply’s time by what it waited on, largest first', () => {
    const report = timeReport([
      reply({
        durationMs: 100_000,
        timeSpent: {
          ...spent(3, { commands: 60_000, thinking: 25_000, waiting: 9000, calls: 6000, later: 0 }),
          requests: 12,
          retries: 1,
        },
      }),
    ]);
    expect(report.parts.map((part) => [part.kind, part.ms, timeShare(part.share)])).toEqual([
      ['commands', 60_000, '60%'],
      ['thinking', 25_000, '25%'],
      ['waiting', 9000, '9%'],
      ['calls', 6000, '6%'],
    ]);
    expect([report.ms, report.replies, report.missing, report.requests, report.retries]).toEqual([
      100_000, 1, 0, 12, 1,
    ]);
    expect(timeShare(0.004)).toBe('<1%');
    expect(timeShare(0)).toBe('0%');
  });

  it('adds a chat’s replies, leaves a running one out and says what was not recorded', () => {
    const report = timeReport([
      { ...reply(), role: 'user', durationMs: 999_999 },
      reply({ durationMs: 30_000, timeSpent: spent(1, { thinking: 20_000, writing: 10_000 }) }),
      // Saved before time was recorded.
      reply({ durationMs: 50_000 }),
      // Cut off a while after its last reading; a kind this release does not know is Other.
      reply({ status: 'cancelled', durationMs: 90_000, timeSpent: spent(1, { later: 60_000 }) }),
      // Neither a duration nor a reading.
      reply({ status: 'error' }),
      reply({ status: 'running', durationMs: 5000, timeSpent: spent(1, { thinking: 5000 }) }),
    ]);
    expect(report.parts.map((part) => [part.kind, part.ms])).toEqual([
      ['other', 60_000],
      ['thinking', 20_000],
      ['writing', 10_000],
      ['unrecorded', 80_000],
    ]);
    expect([report.ms, report.replies, report.missing]).toEqual([170_000, 3, 1]);
    expect(report.parts.reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(1);
  });

  it('lists calls by their own time, together when they did the same, apart from writing them', () => {
    const tests = { command: 'npm test', commandRun: true };
    const report = timeReport(
      [
        reply({ durationMs: 400_000 }, [
          call('a', { ...tests, elapsedMs: 120_000, writeMs: 500 }),
          call('b', { ...tests, elapsedMs: 100_000, status: 'error' }),
          call('c', {
            name: 'Write',
            path: 'C:\\repo\\src\\big.ts',
            elapsedMs: 41_000,
            writeMs: 40_000,
          }),
          call('d', { name: 'Read', operation: 'read', path: 'C:\\repo\\a.ts', elapsedMs: 300 }),
          // The user's time, never the call's.
          call('e', { name: 'AskUserQuestion', elapsedMs: 90_000, writeMs: 2000 }),
          // Went on in the background, still runs, or ran in no time that was recorded.
          call('f', { ...tests, elapsedMs: 70_000, background: true }),
          call('g', { ...tests, elapsedMs: 70_000, status: 'running' }),
          call('h', { command: 'cargo build', commandRun: true }),
          call('i', { category: 'agent', name: 'Sub-agents', elapsedMs: 99_000 }),
        ]),
        reply({ durationMs: 10_000 }, [call('j', { ...tests, elapsedMs: 30_500 })]),
      ],
      { folder: 'C:\\repo' },
    );
    expect(report.ran).toEqual([
      {
        icon: 'test',
        title: 'npm test',
        code: true,
        hint: 'npm test',
        ms: 250_000,
        count: 3,
        failed: 1,
      },
      {
        icon: 'newFile',
        title: 'Write',
        detail: 'src/big.ts',
        hint: 'C:\\repo\\src\\big.ts',
        ms: 1000,
        count: 1,
        failed: 0,
      },
    ]);
    expect(report.written.map((group) => [group.title, group.detail, group.ms])).toEqual([
      ['Write', 'src/big.ts', 40_000],
      ['AskUserQuestion', undefined, 2000],
    ]);
    expect(hasTimeDetails(report)).toBe(true);
    expect(hasTimeDetails(timeReport([reply({ durationMs: 5000 })]))).toBe(false);
  });

  it('writes the report as Markdown that tables and code spans cannot break', () => {
    const report = timeReport([
      reply({ durationMs: 90_000, timeSpent: { ...spent(1, { commands: 90_000 }), requests: 1 } }, [
        call('a', { command: 'echo `a|b`\nnpm   test', commandRun: true, elapsedMs: 61_000 }),
        call('b', {
          command: 'echo `a|b`\nnpm   test',
          commandRun: true,
          elapsedMs: 4000,
          status: 'error',
        }),
        call('c', { name: 'Grep', operation: 'grep', query: 'a|b', elapsedMs: 2000 }),
      ]),
    ]);
    expect(
      timeReportMarkdown(report, { title: 'Fix | the build', scope: 'This response', rows: 1 }),
    ).toBe(`# Time report: Fix \\| the build

This response, 1m 30s, 1 model request.

| What the reply waited on | Time | Share |
| --- | ---: | ---: |
| Commands | 1m 30s | 100% |

## Longest calls

| Time | Calls | Call |
| ---: | --- | --- |
| 1m 5s | 2 times, 1 failed | \`\` echo \`a\\|b\` … \`\` |

1 more not listed.
`);
  });

  it('reads live data without making it reactive, and plain data alike', () => {
    const read: PropertyKey[] = [];
    const watched = <T extends object>(value: T): T =>
      new Proxy(value, {
        get(target, key, receiver) {
          read.push(key);
          return Reflect.get(target, key, receiver);
        },
      });
    const message = reply({ durationMs: 9000, timeSpent: spent(1, { tools: 9000 }) }, [
      call('a', { name: 'Grep', operation: 'grep', query: 'x', elapsedMs: 9000 }),
    ]);
    const report = timeReport(watched([watched(message)]));
    expect(report.ms).toBe(9000);
    expect(report.ran).toHaveLength(1);
    expect(read).toEqual([]);
  });
});

describe('a reply’s recorded time', () => {
  it('keeps the later reading of its own run, through events, remote runs and saves', () => {
    const message = reply({ status: 'running' });
    const event = (revision: number, run = runId): RunEvent => ({
      kind: 'timespent',
      timeSpent: spent(revision, { thinking: revision * 1000 }, run),
    });
    // Nobody waits for a running reply's reading: it goes out with the next change.
    expect(applyRunEvent(message, event(2))).toBe('clock');
    applyRunEvent(message, event(1));
    applyRunEvent(message, event(3, '22222222-2222-4222-8222-222222222222'));
    applyRunEvent(message, { kind: 'timespent', timeSpent: { revision: 9 } as TimeSpent });
    expect(message.timeSpent?.revision).toBe(2);
    expect(messageSchema.parse(message).timeSpent).toEqual(spent(2, { thinking: 2000 }));

    const events: RunEvent[] = [];
    for (const revision of [1, 3, 2]) retainRunEvent(events, event(revision));
    expect(events).toEqual([event(3)]);
    expect(latestTimeSpent(undefined, spent(1, {}))?.revision).toBe(1);
  });

  it('stays with its reply when an older relay drops it', () => {
    const copy = (blocks: number, timed: boolean): Message => ({
      ...reply({ status: 'running' }),
      id: 'b3f0c7f1-8a0e-4c47-9f64-7a2f9b1d0c11',
      ...(timed ? { timeSpent: spent(4, { thinking: 5000 }) } : {}),
      blocks: Array.from({ length: blocks }, (_, i) => ({ type: 'activity', text: `Step ${i}` })),
    });
    const at = (message: Message) => {
      const shared = emptyShared();
      shared.conversations.push({
        id: 'chat',
        settings: settingsFor(initialWorkspace().preferences),
        title: 'Chat',
        createdAt: '2026-11-24',
        updatedAt: '2026-11-24',
        messages: [message],
      });
      return shared;
    };
    const base = at(copy(1, true));
    // Its own copy moved on too, or only the relay's did.
    for (const local of [at(copy(2, true)), base]) {
      const merged = mergeShared(base, local, at(copy(3, false)));
      expect(merged.conversations[0].messages[0].timeSpent).toEqual(spent(4, { thinking: 5000 }));
      expect(merged.conversations[0].messages[0].blocks).toHaveLength(3);
    }
  });
});
