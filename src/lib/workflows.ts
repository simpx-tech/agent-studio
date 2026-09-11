import { z } from 'zod';

export const workflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(8000),
      }),
    )
    .min(1)
    .max(12),
});
export type Workflow = z.infer<typeof workflowSchema>;
export const workflowProgressSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string().max(80),
  steps: z
    .array(
      z.object({
        title: z.string().max(100),
        status: z.enum(['pending', 'running', 'complete', 'error', 'cancelled']),
      }),
    )
    .max(12),
});
export type WorkflowProgress = z.infer<typeof workflowProgressSchema>;

// Legacy definitions above remain readable/exportable, but are never executed.
// Claude owns native orchestration, including background completion.
export function runTimeoutMs(provider?: unknown) {
  return provider === 'claude' ? 3_660_000 : 360_000;
}

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
  runs: z
    .array(
      z.object({
        id: z.string().max(240),
        taskId: z.string().max(240),
        runId: z.string().max(240),
        name: z.string().max(200),
        status: nativeStatus,
        description: z.string().max(1000),
        scriptPath: z.string().max(4096),
        error: z.string().max(1000),
        phases: z.array(z.object({ index: count, title: z.string().max(200) })).max(64),
        agents: z
          .array(
            z.object({
              index: count,
              id: z.string().max(240),
              label: z.string().max(200),
              phaseIndex: count.nullable(),
              model: z.string().max(200),
              status: nativeStatus,
              tokens: count.nullable(),
              durationMs: count.nullable(),
              result: z.string().max(2000),
            }),
          )
          .max(128),
        tokens: count.nullable(),
        durationMs: count.nullable(),
        limited: z.boolean(),
      }),
    )
    .max(16),
});
export type NativeWorkflows = z.infer<typeof nativeWorkflowsSchema>;
