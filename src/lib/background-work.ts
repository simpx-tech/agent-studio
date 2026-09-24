import { z } from 'zod';
import { toolActivitySchema, type ToolActivity } from './activity';
import type { Message } from './domain';

export type BackgroundRun = {
  id: string;
  kind: 'command' | 'monitor' | 'agent';
  label: string;
  elapsedMs?: number;
  /** When the host measured elapsedMs, so the time keeps advancing between its lists. */
  since?: number;
};

/**
 * Work the CLI moved to the background that still runs, in launch order: shell commands,
 * Monitor watches and sub-agents whose launch returned to the model while they kept going.
 * Only reported descriptions label them; commands themselves stay private.
 */
export function runningBackgroundWork(tools: ToolActivity[]): BackgroundRun[] {
  const runs: BackgroundRun[] = [];
  for (const tool of tools) {
    for (const agent of tool.agents)
      if (agent.background && agent.status === 'running')
        runs.push({ id: agent.id, kind: 'agent', label: agent.name });
    if (!tool.background || tool.status !== 'running') continue;
    const monitor = tool.operation === 'monitor';
    runs.push({
      id: tool.id,
      kind: monitor ? 'monitor' : 'command',
      label: tool.detail || (monitor ? 'Monitor' : 'Background command'),
      elapsedMs: tool.elapsedMs,
    });
  }
  return runs;
}

/** Background work of a reply while it runs, from its reported calls. */
export function replyBackgroundWork(message?: Message): BackgroundRun[] {
  if (message?.status !== 'running') return [];
  return runningBackgroundWork(
    message.blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : [])),
  );
}

const identity = z.string().min(1).max(240);
const hostRunSchema = z.object({
  id: identity,
  runId: identity,
  kind: z.enum(['command', 'monitor']),
  label: z.string().max(2048),
  elapsedMs: z.number().int().min(0).max(31_536_000_000),
});
// The executing computer lists work its chat processes still run, including after the
// reply that started it, and reports each later outcome for that saved reply.
export const backgroundWorkEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'),
    conversationId: identity,
    runs: z.array(hostRunSchema).max(32),
  }),
  z.object({
    kind: z.literal('tool'),
    conversationId: identity,
    runId: identity,
    tool: toolActivitySchema,
  }),
]);
export type BackgroundWorkEvent = z.infer<typeof backgroundWorkEventSchema>;
export type HostBackgroundWork = { runs: z.infer<typeof hostRunSchema>[]; at: number };

/** A running reply's own work first, then what the host still runs for the chat. */
export function combineBackgroundWork(
  reply: BackgroundRun[],
  host?: HostBackgroundWork,
): BackgroundRun[] {
  const listed = new Set(reply.map((run) => run.id));
  return [
    ...reply,
    ...(host?.runs ?? [])
      .filter((run) => !listed.has(run.id))
      .map((run) => ({
        id: run.id,
        kind: run.kind,
        label: run.label,
        elapsedMs: run.elapsedMs,
        since: host!.at,
      })),
  ];
}
