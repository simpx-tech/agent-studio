import { z } from 'zod';
import { providerIds, type ProviderId } from './domain';
import { staticRun, type WorkflowHost } from './workflow-engine';
import { layeredLayout } from './workflow-layout';
import {
  configSchemas,
  freshNodeId,
  graphIssues,
  isNodeType,
  keyFrom,
  nodeIdSchema,
  nodeKeySchema,
  nodeSchema,
  readDefinition,
  readRun,
  type Actor,
  type GraphIssue,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowEvent,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowSummary,
} from './workflow-model';
import { newMission } from './workflow-mission';
import type { PutResult } from './workflow-store';

/**
 * The workflow tools every saved Claude and Codex chat gets (docs/WORKFLOWS.md), answered by the
 * window of the computer running the chat: definitions to list, read and save, runs to start
 * and follow, and missions to start.
 */
export interface StoreAccess {
  summaries(): WorkflowSummary[];
  read(
    id: string,
    events?: number,
  ): Promise<
    { body: unknown; revision: number; kind: string; events: WorkflowEvent[] } | undefined
  >;
  put(
    id: string,
    kind: 'definition' | 'run',
    expected: number | null,
    body: unknown,
  ): Promise<PutResult>;
}

export const generalTools = [
  'workflow_list',
  'workflow_read',
  'workflow_save',
  'workflow_run',
  'workflow_status',
  'mission_start',
] as const;
export type GeneralTool = (typeof generalTools)[number];

const nodeInput = z
  .object({
    id: z.string().optional(),
    key: z.string().optional(),
    type: z.string().min(1),
    title: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    retries: z.number().int().nonnegative().optional(),
    retryDelay: z.number().nonnegative().optional(),
    notes: z.string().optional(),
  })
  .loose();
const edgeInput = z
  .object({
    id: z.string().optional(),
    source: z.string().min(1),
    sourcePort: z.string().optional(),
    target: z.string().min(1),
  })
  .loose();
const inputs = {
  workflow_list: z.object({}).loose(),
  workflow_read: z.object({ id: z.string() }).strict(),
  workflow_save: z
    .object({
      id: z.string().optional(),
      revision: z.number().int().nonnegative().optional(),
      name: z.string().trim().min(1),
      description: z.string().optional(),
      nodes: z.array(nodeInput),
      edges: z.array(edgeInput),
    })
    .strict(),
  workflow_run: z
    .object({
      id: z.string(),
      inputs: z.record(z.string(), z.string()).optional(),
      computer: z.string().optional(),
    })
    .strict(),
  workflow_status: z.object({ id: z.string() }).strict(),
  mission_start: z
    .object({
      mission: z.string().trim().min(1),
      title: z.string().optional(),
      folder: z.object({ computer: z.string().optional(), path: z.string() }).strict().optional(),
      orchestrator: z
        .object({
          provider: z.enum(providerIds).optional(),
          account: z.string().optional(),
          model: z.string().optional(),
          reasoning: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
};

/**
 * A graph an agent or the editor wrote, made whole: ids and keys where missing, connections by
 * key or id, step settings with defaults, and positions laid out for steps without one.
 */
export function normalizeGraph(
  nodes: z.infer<typeof nodeInput>[],
  edges: z.infer<typeof edgeInput>[],
): { graph: WorkflowGraph; issues: GraphIssue[] } {
  const issues: GraphIssue[] = [];
  const keys = new Set<string>();
  const ids = new Set<string>();
  const result: WorkflowNode[] = [];
  for (const input of nodes) {
    const id =
      input.id && nodeIdSchema.safeParse(input.id).success && !ids.has(input.id)
        ? input.id
        : freshNodeId();
    ids.add(id);
    const key =
      input.key && nodeKeySchema.safeParse(input.key).success && !keys.has(input.key)
        ? input.key
        : keyFrom(input.key || input.title || input.id || input.type, keys);
    keys.add(key);
    let config = input.config ?? {};
    if (isNodeType(input.type)) {
      const read = configSchemas[input.type].safeParse(config);
      if (read.success) config = read.data as Record<string, unknown>;
      else
        issues.push({
          nodeId: id,
          message: `${input.title || key}: ${read.error.issues.map((i) => `${i.path.join('.') || 'config'} ${i.message}`).join('; ')}`,
          blocking: true,
        });
    }
    result.push(
      nodeSchema.parse({
        id,
        key,
        type: input.type,
        title: input.title ?? '',
        config,
        ...(input.position ? { position: input.position } : {}),
        ...(input.onError ? { onError: input.onError } : {}),
        ...(input.retries !== undefined ? { retries: input.retries } : {}),
        ...(input.retryDelay !== undefined ? { retryDelay: input.retryDelay } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      }),
    );
  }
  // Connections may name steps by key or id, as given or as made.
  const byName = new Map<string, string>();
  nodes.forEach((input, i) => {
    if (input.id) byName.set(input.id, result[i].id);
    if (input.key) byName.set(input.key, result[i].id);
    byName.set(result[i].id, result[i].id);
    byName.set(result[i].key, result[i].id);
  });
  const resultEdges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const input of edges) {
    const source = byName.get(input.source);
    const target = byName.get(input.target);
    if (!source || !target) {
      issues.push({
        message: `A connection names a missing step: ${input.source} to ${input.target}.`,
        blocking: true,
      });
      continue;
    }
    const id =
      input.id && !edgeIds.has(input.id) ? input.id : `e${crypto.randomUUID().slice(0, 8)}`;
    edgeIds.add(id);
    resultEdges.push({ id, source, target, sourcePort: input.sourcePort || 'out' });
  }
  if (nodes.some((n) => !n.position)) {
    const positions = layeredLayout(
      result.map((n) => ({ id: n.id, width: 240, height: 96 })),
      resultEdges,
      { gapX: 80, gapY: 40 },
    );
    for (const node of result) node.position = positions.get(node.id) ?? node.position;
  }
  const graph = { nodes: result, edges: resultEdges };
  return { graph, issues: [...issues, ...graphIssues(graph)] };
}

function findComputer(host: WorkflowHost, text?: string) {
  if (!text) return undefined;
  const wanted = text.trim().toLowerCase();
  const computers = host.computers();
  return (
    computers.find((c) => c.environmentId === text || c.computerId === text) ??
    computers.find((c) => c.name.toLowerCase() === wanted)
  );
}

/** Answers a general workflow tool for the chat `conversationId`. */
export async function generalCall(
  store: StoreAccess,
  host: WorkflowHost,
  tool: GeneralTool,
  raw: unknown,
  caller: { conversationId: string; title: string },
): Promise<string> {
  const parsed = inputs[tool].safeParse(raw ?? {});
  if (!parsed.success)
    throw new Error(
      `Invalid ${tool} input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`,
    );
  const actor: Actor = {
    kind: 'agent',
    conversationId: caller.conversationId,
    title: caller.title,
  };
  const now = host.now();
  switch (tool) {
    case 'workflow_list': {
      const summaries = store.summaries();
      return JSON.stringify(
        {
          workflows: summaries
            .filter((s) => s.kind === 'definition')
            .map((s) => ({
              id: s.id,
              name: s.title,
              description: s.description,
              steps: s.steps,
              revision: s.revision,
              schedules: s.schedules,
            })),
          runs: summaries
            .filter((s) => s.kind === 'run')
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((s) => ({
              id: s.id,
              title: s.title,
              mode: s.mode === 'dynamic' ? 'mission' : 'workflow',
              status: s.status,
              waits: s.detail || undefined,
              updatedAt: s.updatedAt,
            })),
        },
        null,
        2,
      );
    }
    case 'workflow_read': {
      const { id } = parsed.data as z.infer<typeof inputs.workflow_read>;
      const doc = await store.read(id);
      if (!doc || doc.kind !== 'definition')
        throw new Error('No saved workflow has that id. workflow_list lists them.');
      const definition = readDefinition(doc.body);
      if (!definition) throw new Error('This workflow cannot be read by this release.');
      return JSON.stringify(
        {
          id,
          revision: doc.revision,
          name: definition.name,
          description: definition.description,
          nodes: definition.graph.nodes,
          edges: definition.graph.edges,
          issues: graphIssues(definition.graph),
        },
        null,
        2,
      );
    }
    case 'workflow_save': {
      const input = parsed.data as z.infer<typeof inputs.workflow_save>;
      const { graph, issues } = normalizeGraph(input.nodes, input.edges);
      const existing = input.id ? await store.read(input.id) : undefined;
      if (input.id && (!existing || existing.kind !== 'definition'))
        throw new Error('No saved workflow has that id. Omit id to create one.');
      if (existing && input.revision !== undefined && input.revision !== existing.revision)
        throw new Error(
          `This workflow changed since revision ${input.revision} (now ${existing.revision}). Read it again with workflow_read.`,
        );
      const before = existing ? readDefinition(existing.body) : undefined;
      const at = new Date(now).toISOString();
      const schedules = graph.nodes.some(
        (n) =>
          n.type === 'start' &&
          Array.isArray((n.config as { schedules?: unknown[] }).schedules) &&
          (n.config as { schedules: unknown[] }).schedules.length,
      );
      const definition: WorkflowDefinition = {
        name: input.name,
        description: input.description ?? before?.description ?? '',
        graph,
        runsOn: before?.runsOn || (schedules ? host.self().environmentId : ''),
        elsewhere: before?.elsewhere ?? true,
        createdAt: before?.createdAt ?? at,
        updatedAt: at,
        createdBy: before?.createdBy ?? actor,
        updatedBy: actor,
      };
      const id = input.id ?? crypto.randomUUID();
      const result = await store.put(id, 'definition', existing?.revision ?? null, definition);
      if (!result.ok)
        throw new Error('This workflow changed meanwhile. Read it again with workflow_read.');
      return JSON.stringify(
        {
          id,
          revision: result.doc.revision,
          steps: graph.nodes.map((n) => ({ id: n.id, key: n.key, type: n.type })),
          issues: issues.map((i) => `${i.blocking ? 'Blocks running' : 'Note'}: ${i.message}`),
        },
        null,
        2,
      );
    }
    case 'workflow_run': {
      const input = parsed.data as z.infer<typeof inputs.workflow_run>;
      const doc = await store.read(input.id);
      const definition = doc?.kind === 'definition' ? readDefinition(doc.body) : undefined;
      if (!doc || !definition)
        throw new Error('No saved workflow has that id. workflow_list lists them.');
      const blocking = graphIssues(definition.graph).filter((i) => i.blocking);
      if (blocking.length)
        throw new Error(
          `This workflow cannot run yet: ${blocking.map((i) => i.message).join(' ')}`,
        );
      const computer = input.computer ? findComputer(host, input.computer) : undefined;
      if (input.computer && !computer) throw new Error(`No computer is called ${input.computer}.`);
      const run = staticRun(
        input.id,
        definition,
        doc.revision,
        input.inputs ?? {},
        {
          preferred: computer?.environmentId ?? host.self().environmentId,
          elsewhere: definition.elsewhere,
        },
        actor,
        now,
      );
      const id = crypto.randomUUID();
      await host.createRun(id, run);
      return `Started run ${id} of "${definition.name}". Follow it with workflow_status.`;
    }
    case 'workflow_status': {
      const { id } = parsed.data as z.infer<typeof inputs.workflow_status>;
      const doc = await store.read(id, 0);
      const run = doc?.kind === 'run' ? readRun(doc.body) : undefined;
      if (!doc || !run) throw new Error('No run or mission has that id. workflow_list lists them.');
      return JSON.stringify(runStatus(host, run, doc.events), null, 2);
    }
    case 'mission_start': {
      const input = parsed.data as z.infer<typeof inputs.mission_start>;
      const self = host.self();
      const computer = input.folder?.computer
        ? findComputer(host, input.folder.computer)
        : host.computers().find((c) => c.environmentId === self.environmentId);
      if (input.folder?.computer && !computer)
        throw new Error(`No computer is called ${input.folder.computer}.`);
      const provider = (input.orchestrator?.provider ??
        host.conversation(caller.conversationId)?.settings.provider ??
        'claude') as ProviderId;
      const account = input.orchestrator?.account
        ? host
            .accounts()
            .find(
              (a) =>
                a.provider === provider &&
                (a.connectionId === input.orchestrator!.account ||
                  a.name.toLowerCase() === input.orchestrator!.account!.toLowerCase()),
            )
        : undefined;
      const run = newMission({
        title: input.title ?? '',
        text: input.mission,
        ...(input.folder?.path && computer
          ? {
              location: {
                computerId: computer.computerId,
                environmentId: computer.environmentId,
                path: input.folder.path,
              },
            }
          : {}),
        orchestrator: {
          provider,
          connectionId: account?.connectionId ?? '',
          model: input.orchestrator?.model ?? '',
          reasoning: (input.orchestrator?.reasoning ?? '') as never,
        },
        driver: { preferred: self.environmentId, elsewhere: true },
        actor,
        now,
      });
      const id = crypto.randomUUID();
      await host.createRun(id, run);
      return `Started mission ${id} "${run.title}". The user follows it under Workflows; workflow_status reads it.`;
    }
  }
}

/** A run as workflow_status reports it. */
export function runStatus(host: WorkflowHost, run: WorkflowRun, events: WorkflowEvent[]) {
  const text = (conversationId?: string, messageId?: string) => {
    const message = conversationId
      ? host.conversation(conversationId)?.messages.find((m) => m.id === messageId)
      : undefined;
    return message
      ? message.blocks
          .filter((b) => b.type === 'markdown')
          .map((b) => (b as { text: string }).text)
          .join('\n\n')
      : undefined;
  };
  return {
    title: run.title,
    mode: run.mode === 'dynamic' ? 'mission' : 'workflow',
    status: run.status,
    ...(run.detail ? { waits: run.detail } : {}),
    ...(run.output !== undefined ? { output: run.output } : {}),
    ...(run.mode === 'static'
      ? {
          steps: run.activations.map((a) => {
            const node = run.graph.nodes.find((n) => n.id === a.nodeId);
            return {
              step: node?.key ?? a.nodeId,
              status: a.status,
              ...(a.scope ? { item: a.scope } : {}),
              ...(a.wait ? { waits: a.wait } : {}),
              ...(a.error ? { error: a.error } : {}),
              ...(a.output
                ? {
                    output:
                      a.output.text ??
                      text(a.output.ref?.conversationId, a.output.ref?.messageId) ??
                      a.output.json,
                  }
                : {}),
              ...(a.conversationId ? { chat: a.conversationId } : {}),
            };
          }),
        }
      : {
          plan: run.tasks.map(({ id, title, status, dependsOn, result }) => ({
            id,
            title,
            status,
            dependsOn,
            result,
          })),
          agents: run.agents.map(({ conversationId, title, role, status, wait }) => ({
            chat: conversationId,
            title,
            role,
            status,
            ...(wait ? { waits: wait } : {}),
          })),
          notes: run.notes.filter((n) => !n.deleted).map(({ title, text }) => ({ title, text })),
        }),
    questions: run.questions
      .filter((q) => q.status === 'pending')
      .map((q) => q.questions.map((x) => x.question).join(' / ')),
    history: events.slice(-40).map(({ at, kind, text }) => ({ at, kind, text })),
  };
}
