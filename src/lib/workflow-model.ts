import { z } from 'zod';
import { locationSchema, providerIds, reasoningSchema } from './domain.ts';

/**
 * Workflows (docs/WORKFLOWS.md): static workflows, graphs of steps you or an agent draw, and
 * dynamic workflows, which an orchestrator agent manages. Both are documents of the workflow store
 * (src/lib/workflow-store.ts), never of the workspace. This module is shared with the relay, so
 * it imports with extensions and keeps to what Node's type stripping runs.
 */

const uuid = z.string().uuid();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.string().min(1);
/** A step's id: stable within its workflow, written by the editor or an agent. */
export const nodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** The name templates use for a step's output: `{{research.output}}`. */
export const nodeKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const nodeTypeIds = [
  'start',
  'agent',
  'message',
  'read',
  'condition',
  'loop',
  'merge',
  'wait',
  'ask',
  'confirm',
  'notify',
  'set',
  'screen',
  'screenAction',
  'screenData',
  'workflow',
  'end',
] as const;
export type NodeType = (typeof nodeTypeIds)[number];
export const isNodeType = (type: string): type is NodeType =>
  (nodeTypeIds as readonly string[]).includes(type);

// Which account and model an agent of a step or dynamic workflow uses. An empty connection takes the
// least used ready account of the agent on the computer; an empty model is the CLI's default.
const agentChoiceShape = {
  location: locationSchema.optional(),
  provider: z.enum(providerIds).default('claude'),
  connectionId: z.union([uuid, z.literal('')]).default(''),
  model: z.string().default(''),
  reasoning: reasoningSchema.default(''),
};
export const agentChoiceSchema = z.object(agentChoiceShape);
export type AgentChoice = z.infer<typeof agentChoiceSchema>;
const target = {
  target: z.enum(['step', 'chat']).default('step'),
  // The key of the earlier step whose chat this one uses.
  step: z.string().default(''),
  conversationId: z.union([uuid, z.literal('')]).default(''),
};
export const conditionOps = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'matches',
  'greater',
  'less',
  'empty',
  'notEmpty',
  'true',
] as const;
export const scheduleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  every: z.enum(['minutes', 'hours', 'days', 'weeks']).default('days'),
  interval: z.number().int().positive().default(1),
  // A day's time, HH:MM, for daily and weekly schedules.
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('09:00'),
  // Days of the week for weekly schedules, 0 for Sunday.
  days: z.array(z.number().int().min(0).max(6)).default([1]),
  timezone: z.string().default('UTC'),
  // When the schedule was set, so a computer that was off starts only slots after it.
  since: time.optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/**
 * What starts a run at a Trigger step. A workflow may have several, each starting its own runs:
 * you (Run, or an agent's workflow_run), a schedule, a chat's reply ending or asking, another
 * workflow's run ending, a request to its webhook, a computer coming online or going offline, or
 * an account whose usage limit reset.
 */
export const triggerKinds = [
  'manual',
  'schedule',
  'chat',
  'workflow',
  'webhook',
  'computer',
  'usage',
] as const;
export type TriggerKind = (typeof triggerKinds)[number];
export const chatEvents = ['completed', 'failed', 'stopped', 'question'] as const;
export const runEndings = ['completed', 'failed', 'stopped'] as const;
const anyId = z.union([uuid, z.literal('')]).default('');
export const triggerConfigShape = {
  trigger: z.enum(triggerKinds).default('manual'),
  inputs: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        label: z.string().default(''),
        default: z.string().default(''),
        multiline: z.boolean().default(false),
      }),
    )
    .default([]),
  schedules: z.array(scheduleSchema).default([]),
  // A reply in a matching chat: every filter left empty matches any chat.
  chat: z
    .object({
      events: z.array(z.enum(chatEvents)).default(['completed']),
      environmentId: anyId,
      path: z.string().default(''),
      provider: z.union([z.enum(providerIds), z.literal('')]).default(''),
      title: z.string().default(''),
      // Chats workflows start, left out unless asked for, so a workflow never wakes itself.
      workflowChats: z.boolean().default(false),
    })
    .prefault({}),
  workflow: z
    .object({
      // A saved workflow whose runs it follows, or '' for runs of any workflow, static or dynamic.
      workflowId: anyId,
      statuses: z.array(z.enum(runEndings)).default(['completed']),
    })
    .prefault({}),
  // The relay starts a run when its URL receives a POST; the secret is in the URL.
  webhook: z.object({ secret: z.string().default('') }).prefault({}),
  computer: z
    .object({
      environmentId: anyId,
      event: z.enum(['online', 'offline']).default('online'),
    })
    .prefault({}),
  // An account, or any account of a provider, whose 5-hour or weekly limit reset after it was
  // reached.
  usage: z
    .object({
      connectionId: anyId,
      provider: z.union([z.enum(providerIds), z.literal('')]).default(''),
    })
    .prefault({}),
};

/** Each step's settings, with defaults for anything left out. */
export const configSchemas = {
  start: z.object(triggerConfigShape),
  agent: z.object({
    ...agentChoiceShape,
    prompt: z.string().default(''),
    // Ask for a JSON reply, optionally fitting a JSON Schema written as text.
    json: z.boolean().default(false),
    schema: z.string().default(''),
    // A repeated run of the step for the same loop item continues its chat, or starts a new one.
    chat: z.enum(['continue', 'new']).default('continue'),
    title: z.string().default(''),
    instructions: z.string().default(''),
  }),
  message: z.object({
    ...target,
    text: z.string().default(''),
    mode: z.enum(['next', 'steer']).default('next'),
    wait: z.boolean().default(true),
  }),
  read: z.object({
    ...target,
    what: z.enum(['reply', 'messages', 'chat']).default('reply'),
    count: z.number().int().positive().default(5),
  }),
  condition: z.object({
    left: z.string().default(''),
    op: z.enum(conditionOps).default('contains'),
    right: z.string().default(''),
    ignoreCase: z.boolean().default(true),
  }),
  loop: z.object({
    items: z.string().default(''),
    parallel: z.boolean().default(false),
  }),
  merge: z.object({}),
  wait: z.object({
    mode: z.enum(['for', 'until']).default('for'),
    amount: z.number().nonnegative().default(5),
    unit: z.enum(['seconds', 'minutes', 'hours', 'days']).default('minutes'),
    // HH:MM (the next such time) or an ISO date and time.
    until: z.string().default(''),
  }),
  ask: z.object({
    header: z.string().default(''),
    question: z.string().default(''),
    choices: z.array(z.string()).default([]),
    multiple: z.boolean().default(false),
  }),
  // Asks you to approve, then follows Approved or Rejected.
  confirm: z.object({
    header: z.string().default(''),
    question: z.string().default(''),
    approve: z.string().default('Approve'),
    reject: z.string().default('Reject'),
  }),
  notify: z.object({
    title: z.string().default(''),
    text: z.string().default(''),
  }),
  set: z.object({
    values: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
          value: z.string().default(''),
          json: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  screen: z.object({
    ...agentChoiceShape,
    screenTitle: z.string().default(''),
    spec: z.string().default(''),
    // A screen to update instead of creating one.
    screenId: z.string().default(''),
  }),
  screenAction: z.object({
    environmentId: z.union([uuid, z.literal('')]).default(''),
    screenId: z.string().default(''),
    action: z.string().default(''),
    params: z.record(z.string(), z.string()).default({}),
  }),
  screenData: z.object({
    environmentId: z.union([uuid, z.literal('')]).default(''),
    screenId: z.string().default(''),
    op: z.enum(['load', 'save']).default('load'),
    key: z.string().default(''),
    value: z.string().default(''),
    json: z.boolean().default(false),
  }),
  // Runs another workflow and continues with its result: a saved static workflow, given inputs
  // for its manual trigger, or a dynamic workflow pursuing a goal with an orchestrator of its own.
  workflow: z.object({
    kind: z.enum(['static', 'dynamic']).default('static'),
    workflowId: z.union([uuid, z.literal('')]).default(''),
    inputs: z.record(z.string(), z.string()).default({}),
    goal: z.string().default(''),
    title: z.string().default(''),
    ...agentChoiceShape,
    wait: z.boolean().default(true),
  }),
  end: z.object({
    output: z.string().default(''),
    status: z.enum(['completed', 'failed']).default('completed'),
  }),
} satisfies Record<NodeType, z.ZodTypeAny>;
export type NodeConfig<T extends NodeType> = z.infer<(typeof configSchemas)[T]>;

/**
 * A step. Its settings stay as written, so a step of a newer release survives here; they are read
 * through `nodeConfig`, which fills in defaults.
 */
export const nodeSchema = z.object({
  id: nodeIdSchema,
  key: nodeKeySchema,
  type: z.string().min(1),
  title: z.string().default(''),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).default({}),
  // What a failure does when no step follows the error port.
  onError: z.enum(['stop', 'continue']).default('stop'),
  retries: count.default(0),
  retryDelay: z.number().nonnegative().default(30),
  notes: z.string().default(''),
});
export type WorkflowNode = z.infer<typeof nodeSchema>;
export const edgeSchema = z.object({
  id: z.string().min(1),
  source: nodeIdSchema,
  sourcePort: z.string().min(1).default('out'),
  target: nodeIdSchema,
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export const graphSchema = z.object({
  nodes: z.array(nodeSchema).default([]),
  edges: z.array(edgeSchema).default([]),
});
export type WorkflowGraph = z.infer<typeof graphSchema>;

export const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), environmentId: z.string().optional() }),
  z.object({ kind: z.literal('agent'), conversationId: uuid, title: z.string().optional() }),
  z.object({ kind: z.literal('schedule'), scheduleId: z.string() }),
  z.object({ kind: z.literal('workflow'), runId: uuid }),
  z.object({ kind: z.literal('trigger'), nodeId: z.string(), trigger: z.string() }),
]);
export type Actor = z.infer<typeof actorSchema>;

export const definitionSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  graph: graphSchema.default({ nodes: [], edges: [] }),
  // The computer that runs its triggered runs, and whether another may when it is offline:
  // any computer, or only those `continueOn` names when it does.
  runsOn: z.union([uuid, z.literal('')]).default(''),
  elsewhere: z.boolean().default(true),
  continueOn: z.array(uuid).optional(),
  // The chat in which you change it with an agent, which the chat lists leave out.
  assistant: z.object({ conversationId: uuid }).optional(),
  createdAt: time,
  updatedAt: time,
  createdBy: actorSchema,
  updatedBy: actorSchema,
});
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

const outputShape = {
  port: z.string().optional(),
  text: z.string().optional(),
  json: z.unknown().optional(),
  // A reply's text stays in its chat, which every device holds.
  ref: z.object({ conversationId: uuid, messageId: uuid }).optional(),
};
export const outputSchema = z.object(outputShape);
export type StepOutput = z.infer<typeof outputSchema>;

/**
 * The computer that drives a run, and which may continue it while that one is offline: any
 * computer (`elsewhere`), or, when `continueOn` names some, only those.
 */
export const driverSchema = z.object({
  preferred: uuid,
  elsewhere: z.boolean().default(true),
  continueOn: z.array(uuid).optional(),
});
export type RunDriverChoice = z.infer<typeof driverSchema>;
/** Whether `environmentId` may continue a run its preferred computer left. */
export const mayContinue = (driver: Partial<RunDriverChoice>, environmentId: string) =>
  driver.elsewhere !== false &&
  (driver.continueOn === undefined || driver.continueOn.includes(environmentId));

export const commandSchema = z.object({
  id: uuid,
  kind: z.enum(['pause', 'resume', 'stop', 'retry', 'skip', 'driver']),
  // A step's activation for retry and skip.
  activationId: z.string().optional(),
  // Where the run continues, for `driver`.
  driver: driverSchema.optional(),
  at: time,
  by: z.string().optional(),
});
export type RunCommand = z.infer<typeof commandSchema>;

const questionText = z.string().min(1);
export const runQuestionSchema = z.object({
  id: uuid,
  revision: count,
  status: z.enum(['pending', 'answered', 'cancelled']),
  source: z.enum(['step', 'orchestrator']),
  activationId: z.string().optional(),
  // A Confirm step's question, answered with one of its two buttons.
  confirm: z.object({ approve: z.string(), reject: z.string() }).optional(),
  createdAt: time,
  questions: z
    .array(
      z.object({
        id: questionText,
        header: z.string().default(''),
        question: questionText,
        options: z
          .array(z.object({ label: questionText, description: z.string().default('') }))
          .default([]),
        multiSelect: z.boolean().default(false),
      }),
    )
    .min(1),
  answers: z.array(z.object({ id: questionText, values: z.array(z.string()) })).optional(),
  skipped: z.boolean().optional(),
  answeredAt: time.optional(),
  answeredBy: z.string().optional(),
});
export type RunQuestion = z.infer<typeof runQuestionSchema>;

export const noteSchema = z.object({
  id: z.string().min(1),
  revision: count,
  title: z.string().default(''),
  text: z.string().default(''),
  author: z.enum(['orchestrator', 'user', 'workflow']).default('orchestrator'),
  updatedAt: time,
  deleted: z.boolean().optional(),
});
export type RunNote = z.infer<typeof noteSchema>;

export const activationStatuses = [
  'queued',
  'running',
  'waiting',
  'done',
  'failed',
  'stopped',
  'skipped',
] as const;
export const activationSchema = z.object({
  id: uuid,
  revision: count,
  nodeId: nodeIdSchema,
  // '' for the run itself; each loop item adds `<loop activation>#<index>`, joined by '/'.
  scope: z.string().default(''),
  status: z.enum(activationStatuses),
  input: outputSchema.optional(),
  output: outputSchema.optional(),
  error: z.string().optional(),
  attempts: count.default(0),
  conversationId: uuid.optional(),
  // The reply the step waits for.
  replyId: uuid.optional(),
  waitUntil: time.optional(),
  // What the step waits for now, in one line, and for what kind of thing.
  wait: z.string().optional(),
  waitFor: z
    .enum(['time', 'retry', 'usage', 'ready', 'question', 'child', 'reply', 'chat', 'merge'])
    .optional(),
  // Whether its next start continues an interrupted reply in the same chat.
  resume: z.boolean().optional(),
  questionId: uuid.optional(),
  childRunId: uuid.optional(),
  from: z.object({ activationId: z.string().optional(), edgeId: z.string().optional() }).optional(),
  // A loop's items and progress.
  loop: z
    .object({
      items: z.array(z.unknown()),
      next: count,
      done: count,
      outputs: z.array(z.string()),
      parallel: z.boolean(),
      // Items whose steps ended, by index.
      finished: z.array(count).default([]),
    })
    .optional(),
  // A merge's arrivals, by connection.
  arrivals: z.record(z.string(), outputSchema).optional(),
  createdAt: time,
  startedAt: time.optional(),
  endedAt: time.optional(),
});
export type Activation = z.infer<typeof activationSchema>;

export const taskStatuses = [
  'planned',
  'running',
  'done',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
] as const;
export const taskSchema = z.object({
  id: z.string().min(1),
  revision: count,
  title: z.string().default(''),
  description: z.string().default(''),
  status: z.enum(taskStatuses).default('planned'),
  dependsOn: z.array(z.string()).default([]),
  phase: z.string().default(''),
  result: z.string().default(''),
  createdAt: time,
  updatedAt: time,
});
export type MissionTask = z.infer<typeof taskSchema>;

export const agentStatuses = ['waiting', 'running', 'done', 'failed', 'stopped', 'lost'] as const;
export const runAgentSchema = z.object({
  conversationId: uuid,
  revision: count,
  role: z.enum(['orchestrator', 'worker', 'step']),
  title: z.string().default(''),
  taskId: z.string().optional(),
  activationId: z.string().optional(),
  // Where its replies run: its computer's environment, and the account.
  environmentId: uuid,
  connectionId: uuid.optional(),
  provider: z.enum(providerIds),
  model: z.string().default(''),
  reasoning: reasoningSchema.default(''),
  location: locationSchema.optional(),
  // A chat of yours a dynamic workflow writes to, which stays yours: listed and answering you.
  // The chats a workflow starts belong to it alone, as do those runs before 2026-10-19 marked
  // `listed` when an Agent step or an orchestrator asked to list them.
  external: z.boolean().optional(),
  status: z.enum(agentStatuses),
  // What its chat asks you now, until you answer it.
  asking: z.string().optional(),
  waitUntil: time.optional(),
  wait: z.string().optional(),
  // The reply the workflow waits for, and a message it sends once the agent can start.
  replyId: uuid.optional(),
  pending: z.object({ text: z.string(), mode: z.enum(['next', 'steer']) }).optional(),
  // Agents whose work this one continues, for the graph.
  after: z.array(uuid).default([]),
  startedAt: time,
  endedAt: time.optional(),
});
export type RunAgent = z.infer<typeof runAgentSchema>;

export const sessionSchema = z.object({
  conversationId: uuid,
  environmentId: uuid,
  connectionId: uuid.optional(),
  startedAt: time,
  endedAt: time.optional(),
  reason: z.enum(['start', 'driver', 'failure', 'account', 'restart']),
  turns: count.default(0),
  // Turns that failed in a row, and when the next try goes out.
  failures: count.default(0),
  retryAt: time.optional(),
  // The reply the engine sent last, whose end it waits for.
  replyId: uuid.optional(),
});
export type OrchestratorSession = z.infer<typeof sessionSchema>;

export const timerSchema = z.object({
  id: z.string().min(1),
  at: time,
  reason: z.string().default(''),
  status: z.enum(['pending', 'fired', 'cancelled']),
  createdAt: time,
});
export type RunTimer = z.infer<typeof timerSchema>;

/** What the orchestrator has not heard yet, delivered with its next turn. */
export const inboxSchema = z.object({
  id: z.string().min(1),
  at: time,
  kind: z.enum([
    'agent',
    'answer',
    'timer',
    'computer',
    'note',
    'command',
    'usage',
    'user',
    'workflow',
    'reminder',
  ]),
  text: z.string(),
  conversationId: uuid.optional(),
  messageId: uuid.optional(),
});
export type InboxItem = z.infer<typeof inboxSchema>;

export const runStatuses = ['running', 'paused', 'completed', 'failed', 'stopped'] as const;
export type RunStatus = (typeof runStatuses)[number];
export const childSchema = z.object({
  runId: uuid,
  revision: count,
  title: z.string().default(''),
  activationId: z.string().optional(),
  wait: z.boolean().default(true),
  status: z.enum(runStatuses),
  output: z.string().optional(),
});
export type ChildRun = z.infer<typeof childSchema>;
export const alertSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['question', 'notify', 'completed', 'failed']),
  title: z.string(),
  text: z.string(),
  at: time,
});
export type RunAlert = z.infer<typeof alertSchema>;
/** How many of its latest alerts a run keeps for devices to show; each shows them once. */
export const KEPT_ALERTS = 20;
export const missionSchema = z.object({
  text: z.string().min(1),
  // The project's folder, where its agents work unless the orchestrator chooses another.
  location: locationSchema.optional(),
  orchestrator: agentChoiceSchema,
  workers: agentChoiceSchema.partial().optional(),
});
export type Mission = z.infer<typeof missionSchema>;
export const runSchema = z.object({
  mode: z.enum(['static', 'dynamic']),
  title: z.string().default('Workflow'),
  status: z.enum(runStatuses),
  // What the run waits for now, in one line, or nothing.
  detail: z.string().default(''),
  createdAt: time,
  updatedAt: time,
  startedAt: time,
  endedAt: time.optional(),
  createdBy: actorSchema,
  driver: driverSchema,
  definition: z.object({ id: uuid, revision: count, name: z.string() }).optional(),
  // The trigger that started it and what it handed over.
  trigger: z
    .object({
      nodeId: nodeIdSchema,
      kind: z.string().min(1),
      text: z.string().default(''),
      payload: z.unknown().optional(),
    })
    .optional(),
  // Started by a webhook through the relay: its driver builds the run from its workflow first.
  pending: z.boolean().optional(),
  inputs: z.record(z.string(), z.string()).default({}),
  graph: graphSchema.default({ nodes: [], edges: [] }),
  mission: missionSchema.optional(),
  commands: z.array(commandSchema).default([]),
  handled: z.array(z.string()).default([]),
  questions: z.array(runQuestionSchema).default([]),
  notes: z.array(noteSchema).default([]),
  activations: z.array(activationSchema).default([]),
  tasks: z.array(taskSchema).default([]),
  agents: z.array(runAgentSchema).default([]),
  sessions: z.array(sessionSchema).default([]),
  timers: z.array(timerSchema).default([]),
  inbox: z.array(inboxSchema).default([]),
  output: z.string().optional(),
  // Runs this one started: a Run workflow step's, or a dynamic workflow's.
  children: z.array(childSchema).default([]),
  // Its latest alerts (questions, Notify steps, its end), which each device shows once.
  alerts: z.array(alertSchema).default([]),
  // The run that started this one: a Run workflow step's, which waits for it, or a dynamic
  // workflow's.
  parent: z.object({ runId: uuid, activationId: uuid.optional() }).optional(),
  // A dynamic workflow's reminders after turns that left nothing in progress.
  idle: z.object({ count: count, at: time }).optional(),
  // Start inputs of a scheduled run name their slot.
  slot: z.object({ scheduleId: z.string(), at: time }).optional(),
});
export type WorkflowRun = z.infer<typeof runSchema>;

/** A document of the workflow store: its body is a definition or a run. */
export const docSchema = z.object({
  id: uuid,
  kind: z.enum(['definition', 'run']),
  revision: count,
  updatedAt: time,
  body: z.record(z.string(), z.unknown()),
});
export type WorkflowDoc = z.infer<typeof docSchema>;
export type DefinitionDoc = Omit<WorkflowDoc, 'body'> & {
  kind: 'definition';
  body: WorkflowDefinition;
};
export type RunDoc = Omit<WorkflowDoc, 'body'> & { kind: 'run'; body: WorkflowRun };

/** One entry of a run's history. */
export const eventSchema = z
  .object({
    seq: count,
    at: time,
    kind: z.string().min(1),
    text: z.string(),
    nodeId: z.string().optional(),
    activationId: z.string().optional(),
    taskId: z.string().optional(),
    conversationId: z.string().optional(),
    environmentId: z.string().optional(),
  })
  .loose();
export type WorkflowEvent = z.infer<typeof eventSchema>;
export type EventInput = Omit<WorkflowEvent, 'seq' | 'at'> & { at?: string };

/** The lease of the computer driving a run, in the store's clock. */
export const leaseSchema = z.object({ holder: z.string().min(1), expiresAt: z.number() });
export type Lease = z.infer<typeof leaseSchema>;

/** What lists and the sidebar show of a document, worked out by the store. */
export const summarySchema = z.object({
  id: uuid,
  kind: z.enum(['definition', 'run']),
  revision: count,
  updatedAt: time,
  title: z.string(),
  description: z.string().default(''),
  mode: z.enum(['static', 'dynamic']).optional(),
  status: z.enum(runStatuses).optional(),
  detail: z.string().default(''),
  definitionId: z.string().optional(),
  createdAt: z.string().optional(),
  endedAt: z.string().optional(),
  questions: count.default(0),
  running: count.default(0),
  steps: count.default(0),
  alerts: z.array(alertSchema).default([]),
  // The chats that belong to it, which the chat lists leave out, and chats of yours it writes to.
  conversations: z.array(z.string()).default([]),
  listed: z.array(z.string()).default([]),
  preferred: z.string().optional(),
  elsewhere: z.boolean().optional(),
  continueOn: z.array(z.string()).optional(),
  schedules: z
    .array(
      z.object({
        id: z.string(),
        // The Trigger step the schedule starts runs at.
        nodeId: z.string().optional(),
        every: z.string(),
        interval: z.number(),
        at: z.string(),
        days: z.array(z.number()),
        timezone: z.string(),
        since: z.string().optional(),
      }),
    )
    .default([]),
  // Triggers the computers running a workflow watch for: chat, workflow, computer and usage ones,
  // with their settings. A webhook's secret never leaves its workflow.
  triggers: z
    .array(
      z.object({
        nodeId: z.string(),
        kind: z.string(),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  runsOn: z.string().optional(),
  parent: z.string().optional(),
  // The chat to open: a workflow's assistant chat, or a dynamic workflow's orchestrator.
  chat: z.string().optional(),
  // What started a run.
  trigger: z.string().optional(),
  pending: z.boolean().optional(),
});
export type WorkflowSummary = z.infer<typeof summarySchema>;
export type SummaryTrigger = WorkflowSummary['triggers'][number];

/** The kind of a Trigger step, read from its settings as written. */
export function triggerOf(node: { config?: unknown }): TriggerKind {
  const config = (node.config ?? {}) as { trigger?: unknown; schedules?: unknown };
  const kind = triggerKinds.find((k) => k === config.trigger);
  if (kind) return kind;
  // Steps written before triggers had kinds started runs by hand and on their schedules.
  return Array.isArray(config.schedules) && config.schedules.length ? 'schedule' : 'manual';
}

const active = (status?: string) => status === 'running' || status === 'paused';
export const runActive = (status?: string) => active(status);

/**
 * The summary of a document, read defensively: the store keeps bodies as written, and a summary
 * never fails for a part it does not know.
 */
export function summarize(doc: WorkflowDoc): WorkflowSummary {
  const body = doc.body as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const base = {
    id: doc.id,
    kind: doc.kind,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    questions: 0,
    running: 0,
    steps: 0,
    conversations: [],
    listed: [],
    schedules: [],
    triggers: [],
    alerts: [],
    detail: '',
    description: '',
  };
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
  if (doc.kind === 'definition') {
    const graph = (body.graph ?? {}) as { nodes?: unknown };
    const nodes = list(graph.nodes) as {
      id?: unknown;
      type?: unknown;
      config?: Record<string, unknown>;
    }[];
    const schedules: WorkflowSummary['schedules'] = [];
    const triggers: SummaryTrigger[] = [];
    for (const node of nodes) {
      if (node?.type !== 'start' || typeof node.id !== 'string') continue;
      const kind = triggerOf(node);
      if (kind === 'schedule')
        for (const schedule of list(node.config?.schedules)) {
          const s = scheduleSchema.safeParse(schedule).data;
          if (!s?.enabled) continue;
          const { id, every, interval, at, days, timezone, since } = s;
          schedules.push({
            id,
            nodeId: node.id,
            every,
            interval,
            at,
            days,
            timezone,
            ...(since ? { since } : {}),
          });
        }
      else if (kind === 'chat' || kind === 'workflow' || kind === 'computer' || kind === 'usage') {
        const config = node.config?.[kind];
        triggers.push({
          nodeId: node.id,
          kind,
          config: config && typeof config === 'object' ? (config as Record<string, unknown>) : {},
        });
      } else if (kind === 'webhook') triggers.push({ nodeId: node.id, kind, config: {} });
    }
    const assistant = text((body.assistant as { conversationId?: unknown } | undefined)?.conversationId);
    const continueOn = ids(body.continueOn);
    return {
      ...base,
      title: text(body.name) || 'Workflow',
      description: text(body.description),
      steps: nodes.length,
      schedules,
      triggers,
      ...(text(body.runsOn) ? { runsOn: text(body.runsOn) } : {}),
      elsewhere: body.elsewhere !== false,
      ...(continueOn ? { continueOn } : {}),
      ...(assistant ? { chat: assistant, conversations: [assistant] } : {}),
    };
  }
  const status = runStatuses.find((s) => s === body.status);
  const agents = list(body.agents) as {
    conversationId?: unknown;
    external?: unknown;
    status?: unknown;
    asking?: unknown;
  }[];
  const conversations: string[] = [];
  const listed: string[] = [];
  for (const agent of agents) {
    if (typeof agent?.conversationId !== 'string') continue;
    (agent.external === true ? listed : conversations).push(agent.conversationId);
  }
  const driver = (body.driver ?? {}) as {
    preferred?: unknown;
    elsewhere?: unknown;
    continueOn?: unknown;
  };
  const definition = (body.definition ?? {}) as { id?: unknown };
  const parent = (body.parent ?? {}) as { runId?: unknown };
  const sessions = list(body.sessions) as { conversationId?: unknown; endedAt?: unknown }[];
  const session = sessions.filter((s) => !s?.endedAt).at(-1) ?? sessions.at(-1);
  const continueOn = ids(driver.continueOn);
  const trigger = text((body.trigger as { kind?: unknown } | undefined)?.kind);
  return {
    ...base,
    title: text(body.title) || 'Workflow',
    mode: body.mode === 'dynamic' ? 'dynamic' : 'static',
    ...(status ? { status } : {}),
    detail: text(body.detail),
    ...(text(definition.id) ? { definitionId: text(definition.id) } : {}),
    ...(text(body.createdAt) ? { createdAt: text(body.createdAt) } : {}),
    ...(text(body.endedAt) ? { endedAt: text(body.endedAt) } : {}),
    // Its own questions and those its agents' chats ask you.
    questions:
      list(body.questions).filter((q) => (q as { status?: unknown })?.status === 'pending')
        .length + agents.filter((a) => typeof a?.asking === 'string' && a.asking).length,
    running: agents.filter((a) => a?.status === 'running').length,
    steps: list((body.graph as { nodes?: unknown } | undefined)?.nodes).length,
    conversations,
    listed,
    ...(text(driver.preferred) ? { preferred: text(driver.preferred) } : {}),
    elsewhere: driver.elsewhere !== false,
    ...(continueOn ? { continueOn } : {}),
    ...(body.mode === 'dynamic' && text(session?.conversationId)
      ? { chat: text(session?.conversationId) }
      : {}),
    ...(trigger ? { trigger } : {}),
    ...(body.pending === true ? { pending: true } : {}),
    ...(text(parent.runId) ? { parent: text(parent.runId) } : {}),
    alerts: list(body.alerts)
      .map((alert) => alertSchema.safeParse(alert).data)
      .filter((alert): alert is RunAlert => !!alert)
      .slice(-5),
  };
}

/** A step's settings with defaults, or the defaults when its settings no longer fit. */
export function nodeConfig<T extends NodeType>(
  node: { type: string; config?: unknown },
  type: T,
): NodeConfig<T> {
  const schema = configSchemas[type];
  const read = schema.safeParse(node.config ?? {});
  return (read.success ? read.data : schema.parse({})) as NodeConfig<T>;
}

/** What each step type is called, what it shows and which ports it offers. */
export const nodeCatalog: Record<
  NodeType,
  { label: string; ports: string[]; input: boolean; description: string }
> = {
  start: { label: 'Trigger', ports: ['out'], input: false, description: 'What starts a run.' },
  agent: {
    label: 'Agent',
    ports: ['out', 'error'],
    input: true,
    description: 'Start a chat with an agent.',
  },
  message: {
    label: 'Message',
    ports: ['out', 'error'],
    input: true,
    description: 'Send a message to a chat.',
  },
  read: { label: 'Read chat', ports: ['out', 'error'], input: true, description: 'Read a chat.' },
  condition: {
    label: 'Condition',
    ports: ['true', 'false'],
    input: true,
    description: 'Branch on a comparison.',
  },
  loop: {
    label: 'Loop',
    ports: ['each', 'done'],
    input: true,
    description: 'Repeat for each item.',
  },
  merge: { label: 'Merge', ports: ['out'], input: true, description: 'Wait for every branch.' },
  wait: { label: 'Wait', ports: ['out'], input: true, description: 'Wait for a time.' },
  ask: { label: 'Ask', ports: ['out'], input: true, description: 'Ask you a question.' },
  confirm: {
    label: 'Confirm',
    ports: ['approved', 'rejected'],
    input: true,
    description: 'Ask you to approve.',
  },
  notify: { label: 'Notify', ports: ['out'], input: true, description: 'Send a notification.' },
  set: { label: 'Set', ports: ['out'], input: true, description: 'Compute values.' },
  screen: {
    label: 'Screen',
    ports: ['out', 'error'],
    input: true,
    description: 'Build or update a screen.',
  },
  screenAction: {
    label: 'Screen action',
    ports: ['out', 'error'],
    input: true,
    description: 'Run a screen action.',
  },
  screenData: {
    label: 'Screen data',
    ports: ['out', 'error'],
    input: true,
    description: 'Load or save screen data.',
  },
  workflow: {
    label: 'Run workflow',
    ports: ['out', 'error'],
    input: true,
    description: 'Run another workflow.',
  },
  end: { label: 'End', ports: [], input: true, description: 'End the run.' },
};
export const portLabels: Record<string, string> = {
  out: '',
  error: 'Error',
  true: 'True',
  false: 'False',
  each: 'Each',
  done: 'Done',
  approved: 'Approved',
  rejected: 'Rejected',
};
/** What each kind of trigger is called on its step and in pickers. */
export const triggerLabels: Record<TriggerKind, string> = {
  manual: 'Manual',
  schedule: 'Schedule',
  chat: 'Chat',
  workflow: 'Workflow ends',
  webhook: 'Webhook',
  computer: 'Computer',
  usage: 'Usage reset',
};
/** A webhook's secret: 32 random bytes as base64url. */
export function webhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The ports a step offers, whatever its type. */
export const nodePorts = (type: string): string[] =>
  isNodeType(type) ? nodeCatalog[type].ports : ['out'];

/** A key for a new step of `type` that no other step has. */
export function freshKey(type: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = (isNodeType(type) ? type : 'step')
    .replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    .replace(/[^a-z0-9_]/g, '');
  for (let n = 1; ; n++) {
    const key = `${stem}_${n}`;
    if (!used.has(key)) return key;
  }
}
/** A key made from a title, for steps an agent wrote without one. */
export function keyFrom(text: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem =
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 's_$1')
      .slice(0, 48) || 'step';
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) if (!used.has(`${stem}_${n}`)) return `${stem}_${n}`;
}
export const freshNodeId = () => `n${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

export function newNode(
  type: NodeType,
  position: { x: number; y: number },
  taken: Iterable<string>,
): WorkflowNode {
  return nodeSchema.parse({
    id: freshNodeId(),
    key: freshKey(type, taken),
    type,
    title: nodeCatalog[type].label,
    position,
    config: configSchemas[type].parse({}),
  });
}

export function newDefinition(
  name: string,
  actor: Actor,
  now = new Date().toISOString(),
): WorkflowDefinition {
  return definitionSchema.parse({
    name,
    description: '',
    graph: {
      nodes: [{ ...newNode('start', { x: 0, y: 0 }, []), key: 'start', title: 'Manual' }],
      edges: [],
    },
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  });
}

export type GraphIssue = { nodeId?: string; edgeId?: string; message: string; blocking: boolean };

/** What keeps a workflow from running, and what only deserves a look. */
export function graphIssues(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Map<string, WorkflowNode>();
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id))
      issues.push({
        nodeId: node.id,
        message: `Step id ${node.id} is used twice.`,
        blocking: true,
      });
    ids.set(node.id, node);
    if (keys.has(node.key))
      issues.push({
        nodeId: node.id,
        message: `The key ${node.key} is used twice.`,
        blocking: true,
      });
    keys.add(node.key);
    if (!isNodeType(node.type))
      issues.push({
        nodeId: node.id,
        message: `${node.title || node.key}: unknown step type ${node.type}.`,
        blocking: true,
      });
  }
  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (!starts.length) issues.push({ message: 'Add a trigger.', blocking: true });
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id))
      issues.push({ edgeId: edge.id, message: 'A connection is listed twice.', blocking: true });
    edgeIds.add(edge.id);
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) {
      issues.push({
        edgeId: edge.id,
        message: 'A connection leads to a missing step.',
        blocking: true,
      });
      continue;
    }
    if (!nodePorts(source.type).includes(edge.sourcePort))
      issues.push({
        edgeId: edge.id,
        message: `${source.title || source.key} has no ${edge.sourcePort} output.`,
        blocking: true,
      });
    if (isNodeType(target.type) && !nodeCatalog[target.type].input)
      issues.push({
        edgeId: edge.id,
        message: `${target.title || target.key} takes no input.`,
        blocking: true,
      });
  }
  // Steps a run never reaches.
  const reached = new Set<string>();
  const next = new Map<string, string[]>();
  for (const edge of graph.edges)
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  const queue = starts.map((s) => s.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  for (const node of graph.nodes)
    if (!reached.has(node.id) && node.type !== 'start')
      issues.push({
        nodeId: node.id,
        message: `${node.title || node.key} is not connected to a trigger.`,
        blocking: false,
      });
  for (const node of graph.nodes) {
    if (!isNodeType(node.type)) continue;
    const label = node.title || node.key;
    const config = nodeConfig(node, node.type);
    const missing = (what: string) =>
      issues.push({ nodeId: node.id, message: `${label}: ${what}`, blocking: true });
    switch (node.type) {
      case 'start': {
        const c = config as NodeConfig<'start'>;
        if (c.trigger === 'schedule' && !c.schedules.some((s) => s.enabled))
          missing('add a schedule.');
        if (c.trigger === 'webhook' && c.webhook.secret.length < 16)
          missing('create its webhook URL.');
        if (c.trigger === 'chat' && !c.chat.events.length) missing('choose what in a chat starts it.');
        if (c.trigger === 'workflow' && !c.workflow.statuses.length)
          missing('choose which endings start it.');
        break;
      }
      case 'agent':
        if (!(config as NodeConfig<'agent'>).prompt.trim()) missing('write a prompt.');
        break;
      case 'confirm':
        if (!(config as NodeConfig<'confirm'>).question.trim()) missing('write what to confirm.');
        break;
      case 'screen':
        if (!(config as NodeConfig<'screen'>).spec.trim()) missing('describe the screen.');
        break;
      case 'message': {
        const c = config as NodeConfig<'message'>;
        if (!c.text.trim()) missing('write the message.');
        if (c.target === 'step' && !keys.has(c.step))
          missing('choose the step whose chat it uses.');
        if (c.target === 'chat' && !c.conversationId) missing('choose a chat.');
        break;
      }
      case 'read': {
        const c = config as NodeConfig<'read'>;
        if (c.target === 'step' && !keys.has(c.step))
          missing('choose the step whose chat it reads.');
        if (c.target === 'chat' && !c.conversationId) missing('choose a chat.');
        break;
      }
      case 'loop':
        if (!(config as NodeConfig<'loop'>).items.trim()) missing('give the list of items.');
        break;
      case 'ask':
        if (!(config as NodeConfig<'ask'>).question.trim()) missing('write the question.');
        break;
      case 'wait': {
        const c = config as NodeConfig<'wait'>;
        if (c.mode === 'until' && !c.until.trim()) missing('give the time to wait until.');
        break;
      }
      case 'screenAction': {
        const c = config as NodeConfig<'screenAction'>;
        if (!c.environmentId || !c.screenId || !c.action) missing('choose a screen and action.');
        break;
      }
      case 'screenData': {
        const c = config as NodeConfig<'screenData'>;
        if (!c.environmentId || !c.screenId || !c.key.trim()) missing('choose a screen and key.');
        break;
      }
      case 'workflow': {
        const c = config as NodeConfig<'workflow'>;
        if (c.kind === 'dynamic' && !c.goal.trim()) missing('write its goal.');
        if (c.kind !== 'dynamic' && !c.workflowId) missing('choose a workflow.');
        break;
      }
    }
  }
  return issues;
}

/** A run question as the shared question form shows it. */
export function questionRequest(question: RunQuestion) {
  return {
    id: question.id,
    revision: question.status === 'pending' ? 1 : question.status === 'answered' ? 2 : 3,
    status: question.status,
    questions: question.questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
      multiSelect: q.multiSelect,
    })),
    ...(question.status === 'answered'
      ? {
          response: {
            requestId: question.id,
            skipped: !!question.skipped,
            answers: question.answers ?? [],
          },
        }
      : {}),
  };
}

/** A question's answer in one line of text, as later steps and the orchestrator read it. */
export function answerText(question: RunQuestion): string {
  if (question.status === 'cancelled') return '(The question was withdrawn.)';
  if (question.skipped) return '(Skipped.)';
  const answers = question.answers ?? [];
  if (question.questions.length === 1) return (answers[0]?.values ?? []).join(', ');
  return question.questions
    .map(
      (q) =>
        `${q.header || q.question}: ${(answers.find((a) => a.id === q.id)?.values ?? []).join(', ')}`,
    )
    .join('\n');
}

/** Reads a run body, filling in what a release that wrote it may have left out. */
export function readRun(body: unknown): WorkflowRun | undefined {
  return runSchema.safeParse(body).data;
}
export function readDefinition(body: unknown): WorkflowDefinition | undefined {
  return definitionSchema.safeParse(body).data;
}
