import type { ToolActivity } from './activity';
import type { ActivitySource } from './activity-groups';
import type { Message } from './domain';

/** One sub-agent of a reply, as the call that started it records it. */
export type Subagent = ToolActivity['agents'][number];

/** A reply's recorded calls, in order. */
export function replyTools(message: Message): ToolActivity[] {
  return message.blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : []));
}

/** A reply's sub-agent by the id of its record, with the call that holds it. */
export function findSubagent(
  tools: ToolActivity[],
  id: string,
): { holder: ToolActivity; agent: Subagent } | undefined {
  for (const holder of tools) {
    const agent = holder.agents.find((a) => a.id === id);
    if (agent) return { holder, agent };
  }
}

/** The sub-agent that started this one, when another sub-agent delegated it. */
export function delegatingSubagent(holder: ToolActivity, agent: Subagent): Subagent | undefined {
  return agent.parentId ? holder.agents.find((a) => a.id === agent.parentId) : undefined;
}

/**
 * The status a sub-agent's own conversation reads with: its outcome once it has one, else the
 * reply's, so that its calls left running after the reply ended read as unconfirmed.
 */
export function subagentReplyStatus(
  agent: Subagent,
  replyStatus: Message['status'],
): Message['status'] {
  switch (agent.status) {
    case 'running':
      return replyStatus;
    case 'error':
    case 'blocked':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'complete';
  }
}

export type RunningSubagent = {
  id: string;
  name: string;
  background: boolean;
  /** Its latest call, which says what it is doing now. */
  latest?: ToolActivity;
  calls: number;
};

const none: RunningSubagent[] = [];

/** The sub-agents a running reply still runs, in launch order, background ones included. */
export function runningSubagents(
  tools: ToolActivity[],
  replyStatus: Message['status'],
): RunningSubagent[] {
  if (replyStatus !== 'running') return none;
  const running: RunningSubagent[] = [];
  for (const holder of tools)
    for (const agent of holder.agents) {
      if (agent.status !== 'running') continue;
      const own = tools.filter((tool) => tool.parentId === agent.id);
      running.push({
        id: agent.id,
        name: agent.name,
        background: !!agent.background,
        latest: own.at(-1),
        calls: own.length,
      });
    }
  return running.length ? running : none;
}

/**
 * The sub-agents a sub-agent started, as one call of its own conversation, like the call that
 * holds a reply's sub-agents. Its status summarizes theirs.
 */
export function nestedSubagents(holder: ToolActivity, agent: Subagent): ToolActivity | undefined {
  const agents = holder.agents.filter((a) => a.parentId === agent.id);
  if (!agents.length) return;
  const statuses = new Set(agents.map((a) => a.status));
  return {
    ...holder,
    id: `${holder.id}:${agent.id}`,
    parentId: undefined,
    detail: undefined,
    elapsedMs: undefined,
    progress: undefined,
    background: false,
    agents,
    status: statuses.has('running')
      ? 'running'
      : statuses.has('error') || statuses.has('blocked')
        ? 'error'
        : statuses.has('unknown')
          ? 'unknown'
          : statuses.has('cancelled')
            ? 'cancelled'
            : 'complete',
  };
}

/**
 * A sub-agent's conversation as activity blocks: its messages among its own calls in the order
 * they came, then the sub-agents it started. Messages saved before their place was recorded
 * follow the calls. Once it has finished, the closing messages that its result repeats are
 * left to the result.
 */
export function subagentTimeline(
  agent: Subagent,
  calls: ToolActivity[],
  options: { nested?: ToolActivity; result?: string } = {},
): ActivitySource[] {
  const ordered = (agent.messages ?? [])
    .filter((message) => message.text.trim())
    .map((message, index) => ({
      message,
      at: Math.min(message.after ?? calls.length, calls.length),
      index,
    }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const result = options.result?.trim();
  let end = ordered.length;
  while (
    result &&
    end > 0 &&
    ordered[end - 1].at >= calls.length &&
    result.includes(ordered[end - 1].message.text.trim())
  )
    end--;
  const blocks: ActivitySource[] = [];
  let next = 0;
  const say = () => {
    const { message } = ordered[next++];
    blocks.push({
      type: 'activity',
      text: message.text,
      progress: { id: `message:${message.id}`, revision: 0 },
    });
  };
  for (const [index, call] of calls.entries()) {
    while (next < end && ordered[next].at <= index) say();
    blocks.push({ type: 'activity', text: call.name, tool: call });
  }
  while (next < end) say();
  if (options.nested)
    blocks.push({ type: 'activity', text: options.nested.name, tool: options.nested });
  return blocks;
}

/** A partial message that stopped before it finished, left by a sub-agent that is done. */
export function interruptedMessage(agent: Subagent): boolean {
  return agent.status !== 'running' && !!agent.messages?.some((m) => !m.complete);
}
