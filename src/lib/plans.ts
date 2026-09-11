import { z } from 'zod';
import type { Message } from './domain';

export const planSchema = z.object({
  revision: z.number().int().nonnegative(),
  explanation: z.string().max(2000).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().max(240),
        title: z.string().min(1).max(1000),
        status: z.enum(['pending', 'running', 'complete']),
        activeForm: z.string().max(1000).optional(),
      }),
    )
    .max(64),
});
export type Plan = z.infer<typeof planSchema>;

export function planStepLabel(status: Plan['steps'][number]['status'], reply: Message['status']) {
  if (status === 'complete') return 'Complete';
  if (reply === 'cancelled') return 'Stopped';
  if (reply === 'error') return 'Unfinished';
  if (reply === 'complete') return 'Not confirmed complete';
  return status === 'running' ? 'In progress' : 'Pending';
}
