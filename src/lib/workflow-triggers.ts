import type { Conversation } from './domain';
import { requestsAttention } from './notifications';
import { replyText, type WorkflowHost } from './workflow-engine';
import { triggerConfigShape, type TriggerKind, type WorkflowSummary } from './workflow-model';
import { exhaustedUntil } from './workflow-usage';

/**
 * Triggers that watch what happens (docs/WORKFLOWS.md): a chat's reply ending or asking, a run
 * ending, a computer coming online or going offline, an account whose usage limit reset. The
 * computer that runs a workflow's triggered runs watches, keeping what it saw last; what it saw
 * when it began watching starts nothing, so a restart never replays the past. Each event has a
 * key naming it, and the run it starts an id derived from that key, so two computers seeing one
 * event start one run.
 */

export type TriggerFire = {
  definitionId: string;
  nodeId: string;
  kind: TriggerKind;
  key: string;
  text: string;
  payload: Record<string, unknown>;
};

const chatConfig = triggerConfigShape.chat;
const workflowConfig = triggerConfigShape.workflow;
const computerConfig = triggerConfigShape.computer;
const usageConfig = triggerConfigShape.usage;

/** A chat's state as triggers read it: its latest reply's id and how it stands. */
function chatState(conversation: Conversation): { state: string; event?: string; id?: string } {
  const reply = conversation.messages.findLast((m) => m.role === 'assistant');
  if (!reply) return { state: '' };
  if (reply.status === 'running') {
    if (!requestsAttention(reply)) return { state: `running:${reply.id}` };
    const question =
      reply.questions?.find((q) => q.status === 'pending')?.id ??
      reply.elicitations?.find((e) => e.status === 'pending')?.id ??
      'tool';
    return { state: `question:${reply.id}:${question}`, event: 'question', id: reply.id };
  }
  const event =
    reply.status === 'complete' ? 'completed' : reply.status === 'cancelled' ? 'stopped' : 'failed';
  return { state: `${event}:${reply.id}`, event, id: reply.id };
}

const folded = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export class TriggerWatch {
  private chats = new Map<string, string>();
  private runs = new Map<string, string>();
  private online = new Map<string, boolean>();
  private exhausted = new Map<string, boolean>();
  private usageAskedAt = 0;

  /**
   * What fired since the last look among `watched`, the definitions whose triggers this computer
   * runs. `hidden` are the chats workflows started.
   */
  observe(
    host: WorkflowHost,
    watched: WorkflowSummary[],
    runs: WorkflowSummary[],
    hidden: Set<string>,
  ): TriggerFire[] {
    const fires: TriggerFire[] = [];
    const triggers = watched.flatMap((summary) =>
      summary.triggers.map((trigger) => ({ summary, trigger })),
    );
    const of = (kind: string) => triggers.filter((t) => t.trigger.kind === kind);
    const now = host.now();

    const chatTriggers = of('chat');
    if (chatTriggers.length)
      for (const conversation of host.conversations()) {
        const { state, event, id } = chatState(conversation);
        const before = this.chats.get(conversation.id);
        this.chats.set(conversation.id, state);
        if (before === undefined || before === state || !event || !id) continue;
        const location = conversation.location;
        const environmentId = location?.executionEnvironmentId ?? location?.environmentId ?? '';
        const reply = conversation.messages.find((m) => m.id === id)!;
        for (const { summary, trigger } of chatTriggers) {
          const config = chatConfig.parse(trigger.config);
          if (!config.events.includes(event as never)) continue;
          if (!config.workflowChats && hidden.has(conversation.id)) continue;
          if (config.environmentId && config.environmentId !== environmentId) continue;
          if (config.path && !folded(location?.path ?? '').startsWith(folded(config.path)))
            continue;
          if (config.provider && config.provider !== conversation.settings.provider) continue;
          if (
            config.title.trim() &&
            !conversation.title.toLowerCase().includes(config.title.trim().toLowerCase())
          )
            continue;
          const text = event === 'failed' ? (reply.error ?? '') : replyText(reply);
          fires.push({
            definitionId: summary.id,
            nodeId: trigger.nodeId,
            kind: 'chat',
            key: `chat:${state}`,
            text,
            payload: {
              event,
              conversationId: conversation.id,
              messageId: id,
              title: conversation.title,
              reply: text,
              ...(reply.error ? { error: reply.error } : {}),
              provider: conversation.settings.provider,
              model: reply.settings?.model ?? conversation.settings.model,
              folder: location?.path ?? '',
              environmentId,
            },
          });
        }
      }

    const runTriggers = of('workflow');
    for (const run of runs) {
      if (run.kind !== 'run' || !run.status) continue;
      const before = this.runs.get(run.id);
      this.runs.set(run.id, run.status);
      const ended =
        run.status === 'completed' || run.status === 'failed' || run.status === 'stopped';
      if (before === undefined || before === run.status || !ended) continue;
      for (const { summary, trigger } of runTriggers) {
        const config = workflowConfig.parse(trigger.config);
        if (!config.statuses.includes(run.status as never)) continue;
        // Any workflow's runs, but never its own unless it names itself.
        if (
          config.workflowId
            ? config.workflowId !== run.definitionId
            : run.definitionId === summary.id
        )
          continue;
        fires.push({
          definitionId: summary.id,
          nodeId: trigger.nodeId,
          kind: 'workflow',
          key: `run:${run.id}:${run.status}`,
          text: run.detail,
          payload: {
            runId: run.id,
            title: run.title,
            status: run.status,
            mode: run.mode === 'dynamic' ? 'dynamic' : 'static',
            ...(run.definitionId ? { workflowId: run.definitionId } : {}),
          },
        });
      }
    }

    const computerTriggers = of('computer');
    if (computerTriggers.length)
      for (const computer of host.computers()) {
        if (computer.online === undefined) continue;
        const before = this.online.get(computer.environmentId);
        this.online.set(computer.environmentId, computer.online);
        if (before === undefined || before === computer.online) continue;
        const event = computer.online ? 'online' : 'offline';
        for (const { summary, trigger } of computerTriggers) {
          const config = computerConfig.parse(trigger.config);
          if (config.event !== event) continue;
          if (config.environmentId && config.environmentId !== computer.environmentId) continue;
          fires.push({
            definitionId: summary.id,
            nodeId: trigger.nodeId,
            kind: 'computer',
            key: `computer:${computer.environmentId}:${event}:${Math.floor(now / 60_000)}`,
            text: `${computer.name} is ${event}`,
            payload: { environmentId: computer.environmentId, computer: computer.name, event },
          });
        }
      }

    const usageTriggers = of('usage');
    if (usageTriggers.length) {
      const accounts = host.accounts().filter((account) =>
        usageTriggers.some(({ trigger }) => {
          const config = usageConfig.parse(trigger.config);
          return config.connectionId
            ? config.connectionId === account.connectionId
            : !config.provider || config.provider === account.provider;
        }),
      );
      // Readings age; the accounts watched are read again every few minutes.
      if (now - this.usageAskedAt > 5 * 60_000) {
        this.usageAskedAt = now;
        for (const account of accounts) host.refreshUsage(account.connectionId, account.provider);
      }
      for (const account of accounts) {
        const until = exhaustedUntil(
          host.usage(account.connectionId, account.provider),
          { provider: account.provider, model: '' },
          now,
        );
        const exhausted = !!until && until > now;
        const before = this.exhausted.get(account.connectionId);
        this.exhausted.set(account.connectionId, exhausted);
        if (before !== true || exhausted) continue;
        for (const { summary, trigger } of usageTriggers) {
          const config = usageConfig.parse(trigger.config);
          if (config.connectionId && config.connectionId !== account.connectionId) continue;
          if (!config.connectionId && config.provider && config.provider !== account.provider)
            continue;
          fires.push({
            definitionId: summary.id,
            nodeId: trigger.nodeId,
            kind: 'usage',
            key: `usage:${account.connectionId}:${Math.floor(now / 60_000)}`,
            text: `${account.name} has room again`,
            payload: {
              connectionId: account.connectionId,
              account: account.name,
              provider: account.provider,
            },
          });
        }
      }
    }
    return fires;
  }
}

/** The id of the run an event starts: the same on every computer that sees it. */
export async function eventRunId(...parts: string[]) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`agent-studio-workflow-event:${parts.join(':')}`),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
