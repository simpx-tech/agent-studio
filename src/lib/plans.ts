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

/** A reply's plan as its footer summarizes it: title, the steps it counts, completed steps, and the
 * step in progress. While the reply runs a step counts from its start, so the last step in progress
 * reads 5/5 (requested 2026-10-31); a reply that ended counts the steps it completed. */
export function planProgress(message: Message) {
  const steps = message.workflow?.steps ?? message.plan?.steps;
  if (!steps) return undefined;
  const running = message.status === 'running';
  const step = running ? steps.find((s) => s.status === 'running') : undefined;
  const active = step && 'activeForm' in step ? step.activeForm : undefined;
  const complete = steps.filter((s) => s.status === 'complete').length;
  return {
    title: message.workflow?.name || 'Plan',
    count: running ? complete + steps.filter((s) => s.status === 'running').length : complete,
    complete,
    total: steps.length,
    current: step && (typeof active === 'string' && active ? active : step.title),
  };
}

/** What a plan's count (2/3) tells on hover and to assistive technology: the step it reached while
 * one is in progress (Step 2 of 3), else the steps completed (1 of 3 steps complete). */
export function planCountText(
  plan: { count: number; complete: number; total: number },
  noun = 'step',
) {
  return plan.count > plan.complete
    ? `${noun[0].toUpperCase()}${noun.slice(1)} ${plan.count} of ${plan.total}`
    : `${plan.complete} of ${plan.total} ${noun}s complete`;
}

/** The plan a chat's running reply works through, as its sidebar row counts it (2/3): the newest
 * running reply that reports steps, since a reply taking over another runs beside it. */
export function runningPlanProgress(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].status !== 'running') continue;
    const progress = planProgress(messages[i]);
    if (progress?.total) return progress;
  }
}
