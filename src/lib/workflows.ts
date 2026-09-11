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

// Each CLI step has its own five-minute deadline. Retain a bounded launch margin
// per step in both the relay and controller while keeping heartbeat expiry short.
export function runTimeoutMs(workflow?: unknown) {
  const parsed = workflowSchema.safeParse(workflow);
  return 360_000 * (parsed.success ? parsed.data.steps.length : 1);
}

export function workflowMessage(workflow: Workflow, input: string) {
  return `Run the Claude workflow “${workflow.name}”.${input.trim() ? `\n\nInput:\n${input.trim()}` : ''}\n\nSteps:\n${workflow.steps.map((step, i) => `${i + 1}. ${step.title}`).join('\n')}`;
}
