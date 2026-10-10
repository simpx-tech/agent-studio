import { z } from 'zod';
import type { Message } from './domain';

export const planSchema = z.object({
  revision: z.number().int().nonnegative(),
  explanation: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
      status: z.enum(['pending', 'running', 'complete']),
      activeForm: z.string().optional(),
    }),
  ),
});
export type Plan = z.infer<typeof planSchema>;

export function planStepLabel(status: Plan['steps'][number]['status'], reply: Message['status']) {
  if (status === 'complete') return 'Complete';
  if (reply === 'cancelled') return 'Stopped';
  if (reply === 'error') return 'Unfinished';
  if (reply === 'complete') return 'Not confirmed complete';
  return status === 'running' ? 'In progress' : 'Pending';
}

/** A reply's plan as its footer summarizes it: title, completed steps, and the step in progress. */
export function planProgress(message: Message) {
  const steps = message.workflow?.steps ?? message.plan?.steps;
  if (!steps) return undefined;
  const step = message.status === 'running' ? steps.find((s) => s.status === 'running') : undefined;
  const active = step && 'activeForm' in step ? step.activeForm : undefined;
  return {
    title: message.workflow?.name || 'Plan',
    complete: steps.filter((s) => s.status === 'complete').length,
    total: steps.length,
    current: step && (typeof active === 'string' && active ? active : step.title),
  };
}

/** The plan a chat's running reply works through, as its sidebar row counts it (1/3): the newest
 * running reply that reports steps, since a reply taking over another runs beside it. */
export function runningPlanProgress(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].status !== 'running') continue;
    const progress = planProgress(messages[i]);
    if (progress?.total) return progress;
  }
}
