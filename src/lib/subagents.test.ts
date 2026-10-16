import { describe, expect, it } from 'vitest';
import { toolActivitySchema, type ToolActivity } from './activity';
import type { Message } from './domain';
import {
  carriedSubagents,
  delegatingSubagent,
  findSubagent,
  interruptedMessage,
  nestedSubagents,
  replyTools,
  runningSubagents,
  subagentReplyStatus,
  subagentTimeline,
  type Subagent,
} from './subagents';

const tool = (id: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  id,
  name: 'Read',
  revision: 1,
  category: 'tool',
  status: 'complete',
  sources: [],
  agents: [],
  ...extra,
});
const holder = (agents: Subagent[]) =>
  tool('claude:agents', { category: 'agent', name: 'Sub-agents', status: 'running', agents });
const message = (id: string, text: string, after?: number, complete = true) => ({
  id,
  text,
  complete,
  ...(after == null ? {} : { after }),
});
// What each block of a timeline shows: a call by its id, a message by its text.
const shape = (blocks: ReturnType<typeof subagentTimeline>) =>
  blocks.map((b) => (b.type === 'activity' ? (b.tool ? `call:${b.tool.id}` : b.text) : b.type));

describe('sub-agents', () => {
  it('finds a reply’s sub-agents, who delegated them and what they started', () => {
    const agents = holder([
      { id: 'reader', name: 'Reader', status: 'complete' },
      { id: 'checker', name: 'Checker', status: 'running', parentId: 'reader' },
      { id: 'writer', name: 'Writer', status: 'error', parentId: 'reader' },
      // A Codex sub-agent's parent is the root thread, which no record holds.
      { id: 'thread-2', name: 'Explorer', status: 'complete', parentId: 'root-thread' },
    ]);
    const reply = {
      role: 'assistant',
      status: 'running',
      blocks: [
        { type: 'markdown', text: 'Answer' },
        { type: 'activity', text: 'Sub-agents', tool: agents },
        { type: 'activity', text: 'Checking the logs' },
      ],
    } as unknown as Message;
    expect(replyTools(reply)).toEqual([agents]);
    const found = findSubagent([tool('read'), agents], 'checker');
    expect(found?.holder).toBe(agents);
    expect(delegatingSubagent(agents, found!.agent)?.name).toBe('Reader');
    expect(delegatingSubagent(agents, agents.agents[3])).toBeUndefined();
    expect(findSubagent([agents], 'missing')).toBeUndefined();

    const nested = nestedSubagents(agents, agents.agents[0])!;
    expect(nested.id).toBe('claude:agents:reader');
    expect(nested.agents.map((a) => a.name)).toEqual(['Checker', 'Writer']);
    expect(nested.status).toBe('running');
    expect(nestedSubagents(agents, agents.agents[1])).toBeUndefined();
    // A nested record summarizes its own agents, never the rest of the reply's.
    const done = holder([
      { id: 'reader', name: 'Reader', status: 'running' },
      { id: 'checker', name: 'Checker', status: 'complete', parentId: 'reader' },
      { id: 'writer', name: 'Writer', status: 'cancelled', parentId: 'reader' },
    ]);
    expect(nestedSubagents(done, done.agents[0])?.status).toBe('cancelled');
  });

  it('lists the sub-agents a running reply still runs with what each does now', () => {
    const tools = [
      holder([
        { id: 'reader', name: 'Reader', status: 'running' },
        { id: 'done', name: 'Done', status: 'complete' },
        { id: 'watcher', name: 'Watcher', status: 'running', background: true },
      ]),
      tool('r1', { parentId: 'reader', path: '/src/a.ts' }),
      tool('parent-call'),
      tool('r2', { parentId: 'reader', status: 'running', path: '/src/b.ts' }),
      tool('d1', { parentId: 'done' }),
    ];
    const running = runningSubagents(tools, 'running');
    expect(running.map(({ id, background, calls }) => ({ id, background, calls }))).toEqual([
      { id: 'reader', background: false, calls: 2 },
      { id: 'watcher', background: true, calls: 0 },
    ]);
    expect(running[0].latest?.id).toBe('r2');
    expect(running[1].latest).toBeUndefined();
    // A finished reply runs nothing, whatever its saved records still say.
    expect(runningSubagents(tools, 'complete')).toEqual([]);
    expect(runningSubagents([tool('plain')], 'running')).toEqual([]);
  });

  it('lists the sub-agents a running reply inherited from the replies it took over', () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const reply = (n: number, status: Message['status'], extra: Partial<Message> = {}) =>
      ({
        id: id(n),
        role: 'assistant',
        status,
        createdAt: '2026-10-16T00:00:00.000Z',
        blocks: [],
        ...extra,
      }) as Message;
    const user = (n: number) =>
      ({ id: id(n), role: 'user', status: 'complete', blocks: [] }) as unknown as Message;
    const work = (agents: Subagent[], ...calls: ToolActivity[]) =>
      [holder(agents), ...calls].map((t) => ({
        type: 'activity',
        text: t.name,
        tool: t,
      })) as unknown as Message['blocks'];
    // The first reply's skill update still runs; the second, which took it over, finished its
    // own reviewer and was taken over in turn by the third, which now waits for the update.
    const first = reply(1, 'complete', {
      blocks: work(
        [
          { id: 'skill', name: 'Update the skill', status: 'running', background: true },
          { id: 'old', name: 'Done earlier', status: 'complete', background: true },
        ],
        tool('s1', { parentId: 'skill', status: 'running', path: '/skill/SKILL.md' }),
      ),
    });
    const second = reply(3, 'complete', {
      tookOver: id(1),
      blocks: work([{ id: 'reviewer', name: 'Reviewer', status: 'complete', background: true }]),
    });
    const third = reply(5, 'running', { tookOver: id(3) });
    const carried = carriedSubagents([user(0), first, user(2), second, user(4), third]);
    expect(
      carried.inherited.get(id(5))?.map(({ id, messageId, calls }) => ({ id, messageId, calls })),
    ).toEqual([{ id: 'skill', messageId: id(1), calls: 1 }]);
    expect(carried.inherited.get(id(5))?.[0].latest?.id).toBe('s1');
    expect([...carried.carried]).toEqual([id(3), id(1)]);
    // Once the reply that waits for them ends, nothing is carried, whatever the records say.
    const ended = { ...third, status: 'complete' as const };
    expect(carriedSubagents([first, second, ended]).carried.size).toBe(0);
    // A reply that took nothing over inherits nothing, and a running reply in the chain lists
    // its own.
    expect(carriedSubagents([first, reply(6, 'running')]).inherited.size).toBe(0);
    const lagging = { ...second, status: 'running' as const };
    expect(carriedSubagents([first, lagging, third]).inherited.get(id(5))).toBeUndefined();
  });

  it('places messages among the calls they came between', () => {
    const calls = [tool('c1'), tool('c2'), tool('c3')];
    const agent: Subagent = {
      id: 'reader',
      name: 'Reader',
      status: 'running',
      messages: [
        message('m1', 'Looking at the files', 0),
        message('m2', 'Found the entry point', 2),
        message('empty', '  ', 2),
        message('m3', 'Checking one more', 3),
      ],
    };
    expect(shape(subagentTimeline(agent, calls))).toEqual([
      'Looking at the files',
      'call:c1',
      'call:c2',
      'Found the entry point',
      'call:c3',
      'Checking one more',
    ]);
    // A place past the recorded calls, as when later calls went past the activity limit, ends
    // the conversation.
    expect(shape(subagentTimeline(agent, calls.slice(0, 1)))).toEqual([
      'Looking at the files',
      'call:c1',
      'Found the entry point',
      'Checking one more',
    ]);
    // Messages saved before their place was recorded follow the calls.
    const older: Subagent = {
      ...agent,
      messages: [message('m1', 'First'), message('m2', 'Second')],
    };
    expect(shape(subagentTimeline(older, calls.slice(0, 2)))).toEqual([
      'call:c1',
      'call:c2',
      'First',
      'Second',
    ]);
    const nested = nestedSubagents(
      holder([agent, { id: 'checker', name: 'Checker', status: 'running', parentId: 'reader' }]),
      agent,
    );
    expect(shape(subagentTimeline(agent, [], { nested })).at(-1)).toBe(
      'call:claude:agents:reader',
    );
    const [first] = subagentTimeline(agent, []);
    expect(first).toMatchObject({ progress: { id: 'message:m1' } });
  });

  it('leaves a finished sub-agent’s closing messages to the result that repeats them', () => {
    const calls = [tool('c1')];
    const agent: Subagent = {
      id: 'reader',
      name: 'Reader',
      status: 'complete',
      messages: [
        message('m1', 'Summary', 0),
        message('m2', 'Part one', 1),
        message('m3', 'Part two', 1),
      ],
    };
    expect(
      shape(subagentTimeline(agent, calls, { result: '  Part one\n\nPart two  ' })),
    ).toEqual(['Summary', 'call:c1']);
    // Text before the last call stays in the conversation even when the result quotes it.
    expect(shape(subagentTimeline(agent, calls, { result: 'Summary' }))).toEqual([
      'Summary',
      'call:c1',
      'Part one',
      'Part two',
    ]);
    expect(shape(subagentTimeline(agent, calls, { result: 'Part two' }))).toEqual([
      'Summary',
      'call:c1',
      'Part one',
    ]);
  });

  it('reads a sub-agent’s conversation with its own outcome, else its reply’s', () => {
    const agent = (status: Subagent['status']): Subagent => ({ id: 'a', name: 'A', status });
    expect(subagentReplyStatus(agent('running'), 'running')).toBe('running');
    expect(subagentReplyStatus(agent('running'), 'cancelled')).toBe('cancelled');
    expect(subagentReplyStatus(agent('running'), 'complete')).toBe('complete');
    expect(subagentReplyStatus(agent('complete'), 'running')).toBe('complete');
    expect(subagentReplyStatus(agent('error'), 'running')).toBe('error');
    expect(subagentReplyStatus(agent('blocked'), 'running')).toBe('error');
    expect(subagentReplyStatus(agent('cancelled'), 'complete')).toBe('cancelled');
    expect(subagentReplyStatus(agent('unknown'), 'running')).toBe('complete');
    const partial = { ...agent('cancelled'), messages: [message('m', 'Half', 0, false)] };
    expect(interruptedMessage(partial)).toBe(true);
    expect(interruptedMessage({ ...partial, status: 'running' })).toBe(false);
    expect(interruptedMessage(agent('complete'))).toBe(false);
  });

  it('keeps each message’s place through saved history and older records without it', () => {
    const parse = (after?: unknown) =>
      toolActivitySchema.safeParse({
        ...holder([]),
        agents: [
          {
            id: 'reader',
            name: 'Reader',
            status: 'complete',
            messages: [{ id: 'm', text: 'Hi', complete: true, after }],
          },
        ],
      });
    expect(parse(3).data?.agents[0].messages?.[0].after).toBe(3);
    expect(parse(undefined).success).toBe(true);
    expect(parse(-1).success).toBe(false);
    expect(parse(1.5).success).toBe(false);
  });
});
