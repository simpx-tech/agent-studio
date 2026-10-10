import { z } from 'zod';

export const workflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        prompt: z.string().trim().min(1),
      }),
    )
    .min(1),
});
export type Workflow = z.infer<typeof workflowSchema>;
export const workflowProgressSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      status: z.enum(['pending', 'running', 'complete', 'error', 'cancelled']),
    }),
  ),
});
export type WorkflowProgress = z.infer<typeof workflowProgressSchema>;

// Legacy definitions above remain readable/exportable, but are never executed.
// Claude owns native orchestration, including background completion.

const nativeStatus = z.enum([
  'pending',
  'running',
  'complete',
  'error',
  'cancelled',
  'paused',
  'unknown',
]);
const count = z.number().int().nonnegative();
export const nativeWorkflowsSchema = z.object({
  revision: count,
  limited: z.boolean().optional(),
  runs: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      runId: z.string(),
      name: z.string(),
      status: nativeStatus,
      description: z.string(),
      scriptPath: z.string(),
      error: z.string(),
      phases: z.array(z.object({ index: count, title: z.string() })),
      agents: z.array(
        z.object({
          index: count,
          id: z.string(),
          label: z.string(),
          phaseIndex: count.nullable(),
          model: z.string(),
          status: nativeStatus,
          tokens: count.nullable(),
          durationMs: count.nullable(),
          result: z.string(),
        }),
      ),
      tokens: count.nullable(),
      durationMs: count.nullable(),
      // Runs recorded before 2026-10-10 could reach a display limit; nothing limits them now.
      limited: z.boolean().optional(),
    }),
  ),
});
export type NativeWorkflows = z.infer<typeof nativeWorkflowsSchema>;

const nativeWorkflowLabels: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  complete: 'Complete',
  error: 'Failed',
  cancelled: 'Stopped',
  unknown: 'Unknown',
};
/** A native workflow run or agent status. Work left unfinished when its reply ended never reads as running. */
export function nativeWorkflowStatus(status: string, reply: string) {
  if (['running', 'pending', 'paused'].includes(status) && reply !== 'running')
    return reply === 'cancelled' ? 'Stopped' : 'Unconfirmed';
  return nativeWorkflowLabels[status] ?? 'Unknown';
}
