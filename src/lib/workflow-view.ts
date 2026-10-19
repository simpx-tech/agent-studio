import type { Conversation, Message } from './domain';
import { liveAction } from './activity-groups';
import { arrangeSteps, flowsSideways, layeredLayout, STEP_WIDTH } from './workflow-layout';
import {
  isNodeType,
  nodeCatalog,
  nodeConfig,
  nodePorts,
  portLabels,
  triggerOf,
  type Activation,
  type GraphIssue,
  type NodeType,
  type RunAgent,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRun,
} from './workflow-model';
import { scheduleLabel } from './workflow-schedule';

/** What in a chat starts a chat trigger, in its words. */
export const chatEventLabels = {
  completed: 'A reply ends',
  failed: 'A reply fails',
  stopped: 'A reply stops',
  question: 'A question',
} as const;

/**
 * What the workflow graph shows (docs/WORKFLOWS.md): a card per step, plan task, agent or
 * question, with its state, and the connections between them. A run's cards read their chats'
 * live state, so an agent's card says what it does now.
 */
export type CardStatus =
  | 'idle'
  | 'planned'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'attention'
  | 'done'
  | 'failed'
  | 'stopped';
export type CardRow = {
  id: string;
  label: string;
  status: CardStatus;
  detail?: string;
  conversationId?: string;
};
export type CardData = {
  kind: 'step' | 'orchestrator' | 'task' | 'agent' | 'question' | 'workflow';
  /** The step type, or the kind for mission cards. */
  type: string;
  /** The icon it shows, when not its type's: a trigger's kind. */
  icon?: string;
  title: string;
  subtitle: string;
  status: CardStatus;
  statusText: string;
  rows: CardRow[];
  ports: { id: string; label: string }[];
  /** The ports a connection leaves from. */
  connected?: string[];
  input: boolean;
  count?: string;
  issue?: string;
  conversationId?: string;
  [key: string]: unknown;
};
export type GraphCard = { id: string; position: { x: number; y: number }; data: CardData };
export type GraphLink = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  label?: string;
  active?: boolean;
};
export const CARD_WIDTH = STEP_WIDTH;

const statusTexts: Record<CardStatus, string> = {
  idle: '',
  planned: 'Planned',
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  attention: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};
export const statusText = (status: CardStatus) => statusTexts[status];

/** What a chat's running reply does now, in a few words. */
export function chatActivity(conversation: Conversation | undefined): string | undefined {
  const reply = conversation?.messages.at(-1);
  if (!reply || reply.role !== 'assistant' || reply.status !== 'running') return undefined;
  return replyActivity(reply);
}
function replyActivity(reply: Message): string {
  if (reply.questions?.some((q) => q.status === 'pending')) return 'Waiting for your answer';
  for (let i = reply.blocks.length - 1; i >= 0; i--) {
    const block = reply.blocks[i];
    if (block.type === 'activity' && block.tool && !block.tool.parentId) {
      if (block.tool.status !== 'running') break;
      const action = liveAction(block.tool, 'running');
      return [action.verb, action.target].filter(Boolean).join(' ');
    }
    if (block.type === 'reasoning') return 'Thinking';
    if (block.type === 'markdown' && block.text.trim()) return 'Writing';
  }
  return 'Working';
}

/** A step's settings in a few words, for its card. */
export function stepSummary(
  node: WorkflowNode,
  names: { computer?: (id: string) => string } = {},
): string {
  if (!isNodeType(node.type)) return `Unknown step: ${node.type}`;
  const type = node.type as NodeType;
  switch (type) {
    case 'start': {
      const config = nodeConfig(node, 'start');
      switch (triggerOf(node)) {
        case 'schedule':
          return (
            config.schedules
              .filter((s) => s.enabled)
              .map(scheduleLabel)
              .join(' · ') || 'No schedule'
          );
        case 'chat': {
          const c = config.chat;
          const events = c.events.map((e) => chatEventLabels[e]).join(', ');
          const where = c.environmentId
            ? ` on ${names.computer?.(c.environmentId) ?? 'a computer'}`
            : '';
          return `${events || 'Nothing'} in ${c.title.trim() ? `“${c.title.trim()}”` : 'any chat'}${where}`;
        }
        case 'workflow':
          return `A run ${config.workflow.statuses.join(', ') || 'ends'}`;
        case 'webhook':
          return 'A request to its URL';
        case 'computer':
          return `${config.computer.environmentId ? (names.computer?.(config.computer.environmentId) ?? 'A computer') : 'A computer'} goes ${config.computer.event}`;
        case 'usage':
          return 'A usage limit resets';
        default:
          return config.inputs.length
            ? `Run by hand · ${config.inputs.length} input${config.inputs.length === 1 ? '' : 's'}`
            : 'Run by hand';
      }
    }
    case 'confirm':
      return nodeConfig(node, 'confirm').question || 'An approval';
    case 'agent':
    case 'screen': {
      const config = nodeConfig(node, 'agent');
      const where = config.location
        ? (names.computer?.(
            config.location.executionEnvironmentId ?? config.location.environmentId,
          ) ?? '')
        : 'This computer';
      const agent = config.provider[0].toUpperCase() + config.provider.slice(1);
      return [agent, config.model || '', where].filter(Boolean).join(' · ');
    }
    case 'message': {
      const config = nodeConfig(node, 'message');
      return `${config.mode === 'steer' ? 'Steer' : 'Message'} ${config.target === 'step' ? config.step || 'a step' : 'a chat'}`;
    }
    case 'read': {
      const config = nodeConfig(node, 'read');
      return `${config.what === 'reply' ? 'Latest reply' : config.what === 'chat' ? 'Whole chat' : `Last ${config.count} messages`} of ${config.target === 'step' ? config.step || 'a step' : 'a chat'}`;
    }
    case 'condition': {
      const config = nodeConfig(node, 'condition');
      return `${config.op}${['empty', 'notEmpty', 'true'].includes(config.op) ? '' : ` ${config.right}`}`;
    }
    case 'loop': {
      const config = nodeConfig(node, 'loop');
      return config.parallel ? 'All items at once' : 'One item at a time';
    }
    case 'wait': {
      const config = nodeConfig(node, 'wait');
      return config.mode === 'for' ? `${config.amount} ${config.unit}` : `Until ${config.until}`;
    }
    case 'ask':
      return nodeConfig(node, 'ask').question || 'A question';
    case 'notify':
      return nodeConfig(node, 'notify').title || 'Notification';
    case 'set':
      return (
        nodeConfig(node, 'set')
          .values.map((v) => v.name)
          .join(', ') || 'No values'
      );
    case 'screenAction':
      return nodeConfig(node, 'screenAction').action || 'An action';
    case 'screenData': {
      const config = nodeConfig(node, 'screenData');
      return `${config.op === 'load' ? 'Load' : 'Save'} ${config.key}`;
    }
    case 'workflow':
      return 'Another workflow';
    case 'merge':
      return 'All branches';
    case 'end':
      return nodeConfig(node, 'end').status === 'failed' ? 'Fails the run' : 'Completes the run';
  }
}

const ports = (node: WorkflowNode) =>
  nodePorts(node.type).map((id) => ({ id, label: portLabels[id] ?? id }));
const connectedPorts = (graph: WorkflowGraph, node: WorkflowNode) => [
  ...new Set(graph.edges.filter((e) => e.source === node.id).map((e) => e.sourcePort)),
];
const takesInput = (node: WorkflowNode) =>
  isNodeType(node.type) ? nodeCatalog[node.type].input : true;
const links = (
  graph: WorkflowGraph,
  active: (edge: { source: string; target: string }) => boolean = () => false,
): GraphLink[] =>
  graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourcePort,
    target: edge.target,
    ...(active(edge) ? { active: true } : {}),
  }));

/** A definition's graph, as the editor shows it. */
export function definitionCards(
  graph: WorkflowGraph,
  issues: GraphIssue[],
  names: { computer?: (id: string) => string } = {},
): { cards: GraphCard[]; links: GraphLink[] } {
  return {
    cards: graph.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: {
        kind: 'step',
        type: node.type,
        icon: node.type === 'start' ? `trigger:${triggerOf(node)}` : node.type,
        title: node.title || node.key,
        subtitle: stepSummary(node, names),
        status: 'idle',
        statusText: '',
        rows: [],
        ports: ports(node),
        connected: connectedPorts(graph, node),
        input: takesInput(node),
        issue: issues.find((i) => i.nodeId === node.id && i.blocking)?.message,
        key: node.key,
      },
    })),
    links: links(graph),
  };
}

const activationStatus = (a: Activation): CardStatus =>
  a.status === 'waiting'
    ? a.waitFor === 'question'
      ? 'attention'
      : 'waiting'
    : a.status === 'skipped'
      ? 'done'
      : (a.status as CardStatus);

/** A static run's graph: its steps with what each did, and does now. */
export function staticRunCards(
  run: WorkflowRun,
  conversation: (id: string) => Conversation | undefined,
  names: { computer?: (id: string) => string } = {},
): { cards: GraphCard[]; links: GraphLink[] } {
  const placed = flowsSideways(run.graph.nodes, run.graph.edges)
    ? arrangeSteps(run.graph.nodes, run.graph.edges)
    : undefined;
  const byNode = new Map<string, Activation[]>();
  for (const activation of run.activations)
    byNode.set(activation.nodeId, [...(byNode.get(activation.nodeId) ?? []), activation]);
  const cards = run.graph.nodes.map((node): GraphCard => {
    const activations = byNode.get(node.id) ?? [];
    const order: CardStatus[] = [
      'attention',
      'running',
      'waiting',
      'queued',
      'failed',
      'stopped',
      'done',
    ];
    const status = order.find((s) => activations.some((a) => activationStatus(a) === s)) ?? 'idle';
    const current = activations.find((a) => activationStatus(a) === status);
    const chats = new Map<string, Activation>();
    for (const activation of activations)
      if (activation.conversationId) chats.set(activation.conversationId, activation);
    const rows: CardRow[] = [...chats.entries()].map(([conversationId, activation]) => {
      const chat = conversation(conversationId);
      const live = chatActivity(chat);
      const itemStatus = activationStatus(activation);
      return {
        id: conversationId,
        label: activation.scope
          ? `Item ${Number(activation.scope.split('#').at(-1)) + 1}`
          : chat?.title.split(' · ').at(-1) || 'Chat',
        status: live ? 'running' : itemStatus,
        detail: live ?? activation.wait ?? activation.error,
        conversationId,
      };
    });
    const loop = activations.find((a) => a.loop)?.loop;
    return {
      id: node.id,
      position: placed?.get(node.id) ?? node.position,
      data: {
        kind: 'step',
        type: node.type,
        icon: node.type === 'start' ? `trigger:${triggerOf(node)}` : node.type,
        title: node.title || node.key,
        subtitle: current?.wait ?? current?.error ?? stepSummary(node, names),
        status,
        statusText: current?.wait ?? statusText(status),
        rows,
        ports: ports(node),
        connected: connectedPorts(run.graph, node),
        input: takesInput(node),
        ...(loop
          ? { count: `${loop.finished.length}/${loop.items.length}` }
          : activations.length > 1
            ? { count: `×${activations.length}` }
            : {}),
        key: node.key,
      },
    };
  });
  const running = new Set(
    cards.filter((c) => c.data.status === 'running' || c.data.status === 'queued').map((c) => c.id),
  );
  return { cards, links: links(run.graph, (edge) => running.has(edge.target)) };
}

const agentStatus = (agent: RunAgent, chat: Conversation | undefined): CardStatus => {
  if (agent.status === 'running') {
    const reply = chat?.messages.at(-1);
    if (reply?.role === 'assistant' && reply.questions?.some((q) => q.status === 'pending'))
      return 'attention';
    return 'running';
  }
  if (agent.status === 'waiting') return 'waiting';
  if (agent.status === 'lost') return 'failed';
  return agent.status;
};
const taskStatus = (status: string): CardStatus =>
  status === 'blocked'
    ? 'waiting'
    : status === 'cancelled' || status === 'skipped'
      ? 'stopped'
      : (status as CardStatus);

/** A mission's graph: its orchestrator, plan, agents, questions and workflows, laid out. */
export function missionCards(
  run: WorkflowRun,
  conversation: (id: string) => Conversation | undefined,
  names: { computer: (id: string) => string; account: (id?: string) => string },
): { cards: GraphCard[]; links: GraphLink[] } {
  const cards: GraphCard[] = [];
  const result: GraphLink[] = [];
  const session = run.sessions.filter((s) => !s.endedAt).at(-1) ?? run.sessions.at(-1);
  const orchestratorChat = session ? conversation(session.conversationId) : undefined;
  const thinking = chatActivity(orchestratorChat);
  const ended = run.status !== 'running' && run.status !== 'paused';
  const orchestratorStatus: CardStatus = ended
    ? run.status === 'completed'
      ? 'done'
      : run.status === 'failed'
        ? 'failed'
        : 'stopped'
    : run.status === 'paused'
      ? 'waiting'
      : thinking
        ? 'running'
        : 'idle';
  cards.push({
    id: 'orchestrator',
    position: { x: 0, y: 0 },
    data: {
      kind: 'orchestrator',
      type: 'orchestrator',
      title: 'Orchestrator',
      subtitle: session
        ? [names.computer(session.environmentId), names.account(session.connectionId)]
            .filter(Boolean)
            .join(' · ')
        : 'Starting',
      status: orchestratorStatus,
      statusText:
        thinking ??
        (run.status === 'paused'
          ? 'Paused'
          : ended
            ? statusText(orchestratorStatus)
            : 'Waiting for events'),
      rows:
        run.sessions.length > 1
          ? [
              {
                id: 'sessions',
                label: `Session ${run.sessions.length}`,
                status: 'idle',
                detail: `${run.sessions.length - 1} earlier`,
              },
            ]
          : [],
      ports: [{ id: 'out', label: '' }],
      input: false,
      ...(session ? { conversationId: session.conversationId } : {}),
    },
  });
  const agentRow = (agent: RunAgent): CardRow => {
    const chat = conversation(agent.conversationId);
    const status = agentStatus(agent, chat);
    return {
      id: agent.conversationId,
      label: agent.title,
      status,
      detail:
        chatActivity(chat) ??
        agent.wait ??
        (status === 'done' ? names.computer(agent.environmentId) : undefined),
      conversationId: agent.conversationId,
    };
  };
  const workers = run.agents.filter((a) => a.role !== 'orchestrator');
  const taskIds = new Set(run.tasks.map((t) => t.id));
  for (const task of run.tasks) {
    const rows = workers.filter((a) => a.taskId === task.id).map(agentRow);
    const status = rows.some((r) => r.status === 'attention')
      ? 'attention'
      : rows.some((r) => r.status === 'running')
        ? 'running'
        : taskStatus(task.status);
    cards.push({
      id: `task:${task.id}`,
      position: { x: 0, y: 0 },
      data: {
        kind: 'task',
        type: 'task',
        title: task.title || task.id,
        subtitle: task.result || task.description || task.phase,
        status,
        statusText: statusText(status),
        rows,
        ports: [{ id: 'out', label: '' }],
        input: true,
        ...(task.phase ? { phase: task.phase } : {}),
      },
    });
    const deps = task.dependsOn.filter((d) => taskIds.has(d));
    if (!deps.length)
      result.push({
        id: `o-${task.id}`,
        source: 'orchestrator',
        sourceHandle: 'out',
        target: `task:${task.id}`,
        active: status === 'running',
      });
    for (const dep of deps)
      result.push({
        id: `${dep}-${task.id}`,
        source: `task:${dep}`,
        sourceHandle: 'out',
        target: `task:${task.id}`,
        active: status === 'running',
      });
  }
  for (const agent of workers.filter((a) => !a.taskId || !taskIds.has(a.taskId))) {
    const row = agentRow(agent);
    cards.push({
      id: `agent:${agent.conversationId}`,
      position: { x: 0, y: 0 },
      data: {
        kind: 'agent',
        type: 'agent',
        title: agent.title,
        subtitle: [
          names.computer(agent.environmentId),
          names.account(agent.connectionId),
          agent.model,
        ]
          .filter(Boolean)
          .join(' · '),
        status: row.status,
        statusText: row.detail ?? statusText(row.status),
        rows: [],
        ports: [{ id: 'out', label: '' }],
        input: true,
        conversationId: agent.conversationId,
      },
    });
    const after = agent.after.filter((id) =>
      workers.some((w) => w.conversationId === id && (!w.taskId || !taskIds.has(w.taskId))),
    );
    if (!after.length)
      result.push({
        id: `o-${agent.conversationId}`,
        source: 'orchestrator',
        sourceHandle: 'out',
        target: `agent:${agent.conversationId}`,
        active: row.status === 'running',
      });
    for (const id of after)
      result.push({
        id: `${id}-${agent.conversationId}`,
        source: `agent:${id}`,
        sourceHandle: 'out',
        target: `agent:${agent.conversationId}`,
        active: row.status === 'running',
      });
  }
  for (const question of run.questions.filter((q) => q.source === 'orchestrator')) {
    const status: CardStatus =
      question.status === 'pending'
        ? 'attention'
        : question.status === 'answered'
          ? 'done'
          : 'stopped';
    cards.push({
      id: `question:${question.id}`,
      position: { x: 0, y: 0 },
      data: {
        kind: 'question',
        type: 'ask',
        title: 'Question',
        subtitle: question.questions.map((q) => q.question).join(' / '),
        status,
        statusText: statusText(status),
        rows: [],
        ports: [],
        input: true,
        questionId: question.id,
      },
    });
    result.push({
      id: `q-${question.id}`,
      source: 'orchestrator',
      sourceHandle: 'out',
      target: `question:${question.id}`,
      active: status === 'attention',
    });
  }
  for (const child of run.children) {
    const status: CardStatus =
      child.status === 'running'
        ? 'running'
        : child.status === 'paused'
          ? 'waiting'
          : child.status === 'completed'
            ? 'done'
            : child.status === 'failed'
              ? 'failed'
              : 'stopped';
    cards.push({
      id: `workflow:${child.runId}`,
      position: { x: 0, y: 0 },
      data: {
        kind: 'workflow',
        type: 'workflow',
        title: child.title,
        subtitle: 'Workflow run',
        status,
        statusText: statusText(status),
        rows: [],
        ports: [],
        input: true,
        runId: child.runId,
      },
    });
    result.push({
      id: `w-${child.runId}`,
      source: 'orchestrator',
      sourceHandle: 'out',
      target: `workflow:${child.runId}`,
      active: status === 'running',
    });
  }
  const positions = layeredLayout(
    cards.map((card) => ({ id: card.id, width: CARD_WIDTH, height: cardHeight(card.data) })),
    result,
    { gapX: 32, gapY: 56 },
  );
  for (const card of cards) card.position = positions.get(card.id) ?? card.position;
  return { cards, links: result };
}
/** About how tall a card draws, for laying cards out before they are measured. */
export const cardHeight = (data: CardData) => 74 + (data.subtitle ? 18 : 0) + data.rows.length * 30;

export type Choice = { id: string; name: string; detail?: string };
/** What workflow settings choose from, as the page knows it. */
export type WorkflowPickers = {
  /** Computers by environment id, the one chats run in. */
  computers: Choice[];
  location(environmentId: string): { computerId: string; environmentId: string } | undefined;
  folders(environmentId: string): string[];
  accounts(provider: 'claude' | 'codex' | 'gemini', environmentId: string): Choice[];
  models(
    provider: 'claude' | 'codex' | 'gemini',
    connectionId: string,
  ): (Choice & { levels: string[] })[];
  chats(): Choice[];
  screens(environmentId: string): Choice[];
  workflows(): Choice[];
  computerName(environmentId: string): string;
  accountName(connectionId?: string): string;
  /** The environment of this computer, which drives runs started here by default. */
  here: string;
  /** Computers that can drive a run, and the one a new run prefers. */
  drivers: DriverChoice[];
  defaultDriver: string;
};

/** The computers that can drive runs: desktops and servers, never a WSL distribution. */
export type DriverChoice = Choice & { server: boolean };

/** A run's status, in words. */
export const runStatusNames: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** When a run started or ended: its time today, else its day and time. */
export function runTime(at: string | undefined, now = new Date()): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return now.toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
