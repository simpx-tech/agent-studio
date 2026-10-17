import { providerIds, reasoningSchema, type ProviderId, type Reasoning } from './domain';

/**
 * The agent workflows start with on this device (docs/WORKFLOWS.md): Claude at its maximum
 * reasoning until you choose otherwise, then the agent, account, model and reasoning you chose
 * last, for new workflow and mission chats and for new Agent and Screen steps. Kept in this
 * browser's storage only, never synced.
 */
export type WorkflowAgent = {
  provider: ProviderId;
  connectionId: string;
  model: string;
  reasoning: Reasoning;
};
type Saved = {
  provider?: ProviderId;
  byProvider?: Partial<
    Record<ProviderId, { connectionId?: string; model?: string; reasoning?: Reasoning }>
  >;
  mode?: 'workflow' | 'mission';
};
const key = 'agent-studio.workflow-agent';
const initial: Record<ProviderId, Reasoning> = { claude: 'max', codex: 'xhigh', gemini: '' };

function read(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Saved;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
function write(saved: Saved) {
  try {
    localStorage.setItem(key, JSON.stringify(saved));
  } catch {
    // The choice holds for this window.
  }
}

/** The agent to start with, for `provider` or the agent chosen last. */
export function workflowAgent(provider?: ProviderId): WorkflowAgent {
  const saved = read();
  const chosen =
    provider ?? (providerIds.includes(saved.provider as ProviderId) ? saved.provider! : 'claude');
  const last = saved.byProvider?.[chosen] ?? {};
  const reasoning = reasoningSchema.safeParse(last.reasoning);
  return {
    provider: chosen,
    connectionId: typeof last.connectionId === 'string' ? last.connectionId : '',
    model: typeof last.model === 'string' ? last.model : '',
    reasoning: reasoning.success && last.reasoning !== undefined ? reasoning.data : initial[chosen],
  };
}
/** Remembers the agent chosen for a workflow chat or step. */
export function rememberWorkflowAgent(choice: Partial<WorkflowAgent> & { provider: ProviderId }) {
  const saved = read();
  const before = saved.byProvider?.[choice.provider] ?? {};
  write({
    ...saved,
    provider: choice.provider,
    byProvider: {
      ...saved.byProvider,
      [choice.provider]: {
        ...before,
        ...(choice.connectionId !== undefined ? { connectionId: choice.connectionId } : {}),
        ...(choice.model !== undefined ? { model: choice.model } : {}),
        ...(choice.reasoning !== undefined ? { reasoning: choice.reasoning } : {}),
      },
    },
  });
}
/** Whether a new workflow chat starts a workflow or a mission: the kind chosen last. */
export const workflowMode = (): 'workflow' | 'mission' =>
  read().mode === 'mission' ? 'mission' : 'workflow';
export const rememberWorkflowMode = (mode: 'workflow' | 'mission') => write({ ...read(), mode });
/** The highest reasoning a model lists, for an agent whose remembered level it lacks. */
export function highestReasoning(levels: readonly string[]): Reasoning {
  const order: Reasoning[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  return [...order].reverse().find((level) => levels.includes(level)) ?? '';
}
