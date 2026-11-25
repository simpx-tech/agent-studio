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
import {
  agentOutcome,
  hasTimeDetails,
  makeupText,
  measurementsText,
  timeReport,
  timeReportMarkdown,
  timeShare,
} from './time-report';

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
const asked = (text: string): Message => ({
  id: crypto.randomUUID(),
  role: 'user',
  status: 'complete',
  createdAt: '',
  blocks: [{ type: 'markdown', text }],
});
const note = (id: string, text: string) => ({
  type: 'activity' as const,
  text,
  progress: { id, revision: 1 },
});

describe('time on hold with its reason, and the measurements made', () => {
  it('tells waits for the computer, a build slot and a turn apart, with the measurements', () => {
    const release = (id: string, facts: { label: string; value: string }[]) =>
      call(id, {
        category: 'tool',
        name: 'Release the computer',
        operation: 'pc',
        elapsedMs: 200,
        facts,
      });
    const report = timeReport([
      reply(
        {
          durationMs: 60_000,
          timeSpent: spent(2, { held: 10_000, slot: 20_000, turn: 5_000, commands: 25_000 }),
        },
        [
          release('clean', [{ label: 'Measurement', value: 'Clean' }]),
          release('beside', [
            { label: 'Measurement', value: 'Ran beside other heavy work' },
            {
              label: 'Ran beside',
              value: 'another chat ran `npm test` for 4.0s\nprograms of yours (chrome.exe)',
            },
          ]),
        ],
      ),
    ]);
    expect(report.parts.map((part) => [part.kind, part.name, part.family])).toEqual([
      ['commands', 'Commands', 'work'],
      ['slot', 'Waiting for a build slot', 'hold'],
      ['held', 'Waiting for the computer', 'hold'],
      ['turn', 'Waiting for its turn', 'hold'],
    ]);
    expect(report.measurements).toEqual([
      { reply: 1, clean: true },
      {
        reply: 1,
        clean: false,
        beside: 'another chat ran `npm test` for 4.0s\nprograms of yours (chrome.exe)',
      },
    ]);
    expect(measurementsText(report.measurements)).toBe('2 measurements, 1 beside other heavy work');
    expect(measurementsText([{ reply: 1, clean: true }])).toBe('1 measurement, all clean');
    const markdown = timeReportMarkdown(report, { title: 'Bench', scope: 'One response' });
    expect(markdown).toContain('## Measurements');
    expect(markdown).toContain(
      '| Beside other heavy work | another chat ran `npm test` for 4.0s; programs of yours (chrome.exe) |',
    );
  });
});

describe('time report', () => {
  it('shares a reply’s time by what it waited on, largest first, and by who spent it', () => {
    const report = timeReport([
      reply({
        durationMs: 100_000,
        timeSpent: {
          ...spent(3, {
            commands: 55_000,
            thinking: 25_000,
            waiting: 9000,
            calls: 6000,
            user: 3000,
            startup: 2000,
            later: 0,
          }),
          requests: 12,
          retries: 1,
        },
      }),
    ]);
    expect(report.parts.map((part) => [part.kind, part.family, timeShare(part.share)])).toEqual([
      ['commands', 'work', '55%'],
      ['thinking', 'model', '25%'],
      ['waiting', 'model', '9%'],
      ['calls', 'model', '6%'],
      ['user', 'hold', '3%'],
      ['startup', 'overhead', '2%'],
    ]);
    expect(report.families.map((family) => [family.family, family.ms])).toEqual([
      ['model', 40_000],
      ['work', 55_000],
      ['hold', 3000],
      ['overhead', 2000],
    ]);
    expect(makeupText(report.families)).toBe(
      'Model 40%, Commands and tools 55%, On hold 3%, Overhead 2%',
    );
    expect([report.ms, report.replies, report.missing, report.requests, report.retries]).toEqual([
      100_000, 1, 0, 12, 1,
    ]);
    expect(timeShare(0.004)).toBe('<1%');
    expect(timeShare(0)).toBe('0%');
  });

  it('adds a chat’s replies, each named by what was asked, and says what was not recorded', () => {
    const report = timeReport([
      asked('## Fix the **build**\nIt fails on CI.'),
      reply({ durationMs: 30_000, timeSpent: spent(1, { thinking: 20_000, writing: 10_000 }) }),
      // Saved before time was recorded.
      reply({ durationMs: 50_000 }),
      asked('Release it'),
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
    expect(report.list.map((item) => [item.label, item.ms, makeupText(item.makeup)])).toEqual([
      ['Fix the build', 30_000, 'Model 100%'],
      ['Fix the build', 50_000, 'Not recorded 100%'],
      ['Release it', 90_000, 'Overhead 67%, Not recorded 33%'],
    ]);
    // A chart of one reply's time needs one reply.
    expect(report.timeline).toBeUndefined();
  });

  it('tells what each plan step and each stretch between notes took and was made of', () => {
    const message = reply({
      durationMs: 100_000,
      timeSpent: {
        ...spent(1, { waiting: 10_000, thinking: 30_000, commands: 50_000, writing: 10_000 }),
        timeline: {
          kinds: ['waiting', 'thinking', 'commands', 'writing', 'later'],
          runs: [0, 10_000, 1, 30_000, 2, 50_000, 3, 10_000, 4, 0],
        },
        steps: [
          { at: 5000, title: 'Implement the fix' },
          { at: 45_000, title: 'Run the tests' },
          { at: 85_000 },
          { at: 90_000, title: 'Implement the fix' },
          { at: 95_000 },
        ],
        notes: [
          { at: 8000, id: 'm1' },
          { at: 40_000, id: 'm2' },
          { at: 90_000, id: 'gone' },
        ],
      },
      blocks: [
        note('m1', '**Reading** the `build` script first.\nThen the rest.'),
        note('m2', '- Running the tests'),
      ],
    });
    const report = timeReport([asked('Fix it'), message]);
    expect(
      report.steps.map((step) => [step.title, step.ms, step.stretches, makeupText(step.makeup)]),
    ).toEqual([
      ['Implement the fix', 45_000, 2, 'Model 89%, Commands and tools 11%'],
      ['Run the tests', 40_000, 1, 'Commands and tools 100%'],
      ['Outside the plan', 15_000, 1, 'Model 67%, Commands and tools 33%'],
    ]);
    expect(report.steps.map((step) => timeShare(step.share))).toEqual(['45%', '40%', '15%']);
    expect(report.notes.map((step) => [step.title, step.start, step.ms, step.rest])).toEqual([
      ['Before the first note', 0, 8000, true],
      ['Reading the build script first.', 8000, 32_000, undefined],
      ['Running the tests', 40_000, 50_000, undefined],
      ['Note', 90_000, 10_000, undefined],
    ]);
    expect(makeupText(report.notes[2].makeup)).toBe('Commands and tools 100%');
    // One reply's report draws its time in order, with the steps under it.
    expect(report.timeline?.map((slice) => [slice.kind, slice.start, slice.ms])).toEqual([
      ['waiting', 0, 10_000],
      ['thinking', 10_000, 30_000],
      ['commands', 40_000, 50_000],
      ['writing', 90_000, 10_000],
    ]);
    expect(report.stepSpans).toEqual([
      { title: 'Implement the fix', start: 5000, ms: 40_000 },
      { title: 'Run the tests', start: 45_000, ms: 40_000 },
      { title: 'Implement the fix', start: 90_000, ms: 5000 },
    ]);
    // Of a chat, each step names its reply.
    const chat = timeReport([message, reply({ durationMs: 1000 })]);
    expect(chat.steps.map((step) => step.reply)).toEqual([1, 1, 1]);
    expect(chat.timeline).toBeUndefined();
  });

  it('lists sub-agents with their own calls, and commands by what they did', () => {
    const agents = call('group', {
      category: 'agent',
      name: 'Sub-agents',
      agents: [
        {
          id: 'a1',
          name: 'Explore the relay',
          status: 'complete',
          startMs: 10_000,
          elapsedMs: 60_000,
          task: 'PRIVATE',
        },
        { id: 'a2', name: 'Review the diff', status: 'error', elapsedMs: 5000 },
        { id: 'a3', name: 'Watch the build', status: 'running', background: true },
        { id: 'a4', name: 'Nested', status: 'complete', parentId: 'a1', elapsedMs: 99_000 },
      ],
    });
    const report = timeReport([
      reply(
        {
          durationMs: 200_000,
          timeSpent: {
            ...spent(1, { agents: 65_000, commands: 135_000 }),
            timeline: { kinds: ['agents', 'commands'], runs: [0, 65_000, 1, 135_000] },
          },
        },
        [
          agents,
          // The first sub-agent's calls: two overlap, and one failed.
          call('c1', {
            parentId: 'a1',
            command: 'npm test',
            commandRun: true,
            startMs: 12_000,
            elapsedMs: 20_000,
          }),
          call('c2', {
            parentId: 'a1',
            name: 'Grep',
            operation: 'grep',
            query: 'x',
            startMs: 22_000,
            elapsedMs: 20_000,
            status: 'error',
          }),
          call('c3', { parentId: 'a2', command: 'git diff', commandRun: true, elapsedMs: 1500 }),
          call('c4', { command: 'npm test', commandRun: true, elapsedMs: 120_000 }),
          call('c5', { command: 'cargo build', commandRun: true, elapsedMs: 15_000 }),
          call('c6', { command: 'git status', commandRun: true, elapsedMs: 300 }),
        ],
      ),
    ]);
    expect(
      report.agents.map((agent) => [
        agent.name,
        agent.ms,
        agent.calls,
        agent.failed,
        makeupText(agent.makeup),
        agentOutcome(agent),
      ]),
    ).toEqual([
      ['Explore the relay', 60_000, 2, 1, 'Model 50%, Commands and tools 50%', ''],
      ['Review the diff', 5000, 1, 0, 'Model 70%, Commands and tools 30%', 'Failed'],
      ['Watch the build', undefined, 0, 0, '', 'In background'],
    ]);
    expect(report.agentSpans).toEqual([{ title: 'Explore the relay', start: 10_000, ms: 60_000 }]);
    expect(report.commands.map((group) => [group.name, group.ms, group.count])).toEqual([
      ['Tests', 140_000, 2],
      ['Builds and checks', 15_000, 1],
      ['Git', 1800, 2],
    ]);
    expect(hasTimeDetails(report)).toBe(true);
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
      asked('Fix | it'),
      reply(
        {
          durationMs: 90_000,
          timeSpent: {
            ...spent(1, { commands: 80_000, thinking: 10_000 }),
            requests: 1,
            timeline: { kinds: ['thinking', 'commands'], runs: [0, 10_000, 1, 80_000] },
            steps: [{ at: 0, title: 'Run | it' }],
            notes: [{ at: 10_000, id: 'm1' }],
          },
          blocks: [
            note('m1', 'Running `it` now'),
            {
              type: 'activity',
              text: 'Sub-agents',
              tool: call('g', {
                category: 'agent',
                agents: [{ id: 'a', name: 'Look | around', status: 'cancelled', elapsedMs: 4000 }],
              }),
            },
          ],
        },
        [],
      ),
      reply({ durationMs: 30_000 }, [
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
    expect(timeReportMarkdown(report, { title: 'Fix | the build', scope: 'Whole chat', rows: 1 }))
      .toBe(`# Time report: Fix \\| the build

Whole chat, 2m 0s over 2 replies, 1 model request.

| What the reply waited on | Time | Share |
| --- | ---: | ---: |
| Commands | 1m 20s | 67% |

2 more not listed.

## Plan steps

| Step | Time | Share | Made of |
| --- | ---: | ---: | --- |
| Run \\| it (reply 1) | 1m 30s | 75% | Model 11%, Commands and tools 89% |

## Stretches by note

| Began with | Time | Share | Made of |
| --- | ---: | ---: | --- |
| Running it now (reply 1) | 1m 20s | 67% | Commands and tools 100% |

1 more not listed.

## Sub-agents

| Sub-agent | Time | Calls | Made of |
| --- | ---: | ---: | --- |
| Look \\| around, Stopped | 4.0s | 0 | Model 100% |

## Commands by kind

| Kind | Time | Calls |
| --- | ---: | ---: |
| Other commands | 1m 5s | 2 |

## Longest calls

| Time | Times | Call |
| ---: | --- | --- |
| 1m 5s | 2 times, 1 failed | \`\` echo \`a\\|b\` … \`\` |

1 more not listed.

## Replies

| Reply | Time | Made of |
| --- | ---: | --- |
| Fix \\| it | 1m 30s | Model 11%, Commands and tools 89% |

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
    const report = timeReport(watched([watched(asked('Find it')), watched(message)]));
    expect(report.ms).toBe(9000);
    expect(report.ran).toHaveLength(1);
    expect(report.list[0].label).toBe('Find it');
    expect(read).toEqual([]);
  });
});

describe('a reply’s recorded time', () => {
  it('keeps the later reading of its own run, through events, remote runs and saves', () => {
    const message = reply({ status: 'running' });
    const event = (revision: number, run = runId): RunEvent => ({
      kind: 'timespent',
      timeSpent: {
        ...spent(revision, { thinking: revision * 1000 }, run),
        timeline: { kinds: ['thinking'], runs: [0, revision * 1000] },
        steps: [{ at: 0, title: 'Think' }, { at: 500 }],
        notes: [{ at: 100, id: 'm1' }],
      },
    });
    // Nobody waits for a running reply's reading: it goes out with the next change.
    expect(applyRunEvent(message, event(2))).toBe('clock');
    applyRunEvent(message, event(1));
    applyRunEvent(message, event(3, '22222222-2222-4222-8222-222222222222'));
    applyRunEvent(message, { kind: 'timespent', timeSpent: { revision: 9 } as TimeSpent });
    expect(message.timeSpent?.revision).toBe(2);
    expect(messageSchema.parse(message).timeSpent).toEqual(event(2).timeSpent);

    const events: RunEvent[] = [];
    for (const revision of [1, 3, 2]) retainRunEvent(events, event(revision));
    expect(events).toEqual([event(3)]);
    expect(latestTimeSpent(undefined, spent(1, {}))?.revision).toBe(1);
  });

  it('keeps when calls and sub-agents began and how long they took through a save', () => {
    const saved = messageSchema.parse(
      reply({}, [
        call('a', { startMs: 1200, elapsedMs: 900, writeMs: 300 }),
        call('g', {
          category: 'agent',
          agents: [
            { id: 'a1', name: 'Explore', status: 'complete', startMs: 2000, elapsedMs: 700 },
          ],
        }),
      ]),
    );
    const [first, group] = saved.blocks.map((block) =>
      block.type === 'activity' ? block.tool : 0,
    );
    expect(first).toMatchObject({ startMs: 1200, elapsedMs: 900, writeMs: 300 });
    expect(group && group.agents[0]).toMatchObject({ startMs: 2000, elapsedMs: 700 });
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
