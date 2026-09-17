import type { ChatSettings, Message } from './domain';
import { reasoningName, type ModelInfo } from './models';

export type ReplyTimeTotal = { durationMs: number | null; missing: number };

export function replyTimeTotals(messages: Message[]): Map<string, ReplyTimeTotal> {
  const totals = new Map<string, ReplyTimeTotal>();
  let durationMs: number | null = null;
  let missing = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || message.status === 'running') continue;
    const elapsed = message.durationMs;
    if (elapsed != null && Number.isFinite(elapsed) && elapsed >= 0)
      durationMs = (durationMs ?? 0) + elapsed;
    else missing++;
    totals.set(message.id, { durationMs, missing });
  }
  return totals;
}

export function formatReplyTime(durationMs: number): string {
  const tenths = Math.round(durationMs / 100);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1);
  return `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${seconds}s`;
}

export function formatModelName(id: string): string {
  if (!id) return 'CLI default';
  return id.replace(
    /(^|[- ])([a-z]+)/g,
    (_, separator: string, word: string) =>
      separator + (word === 'gpt' ? 'GPT' : word[0].toUpperCase() + word.slice(1)),
  );
}

export function selectedModelName(model: string, catalog: ModelInfo[]): string {
  const name = catalog.find((entry) => entry.id === model)?.name;
  return name?.replace(/^CLI default\s*·\s*/, '') || formatModelName(model);
}

export function replyModelName(message: Message): string {
  const reported = message.usage?.model;
  if (reported && reported !== message.settings?.model) return formatModelName(reported);
  return message.modelName || formatModelName(reported || message.settings?.model || '');
}

// Older snapshots may lack a connection; only two recorded connections can differ.
export function replyAccountChanged(previous: ChatSettings, next: ChatSettings): boolean {
  return !!previous.connectionId && !!next.connectionId && previous.connectionId !== next.connectionId;
}

export function replySettingsChanged(previous: ChatSettings, next: ChatSettings): boolean {
  return (
    previous.provider !== next.provider ||
    previous.model !== next.model ||
    previous.reasoning !== next.reasoning ||
    replyAccountChanged(previous, next)
  );
}

// The account label recorded with the reply keeps history readable if the account is
// later renamed or removed; a resolver supplies the current name when available.
export function replyAccountName(
  message: Message,
  accountName?: (connectionId: string) => string | undefined,
): string {
  const connectionId = message.settings?.connectionId;
  const current = connectionId ? accountName?.(connectionId) : undefined;
  return current || message.executionLabel?.split(' · ')[0] || 'another';
}

export function replySwitches(
  messages: Message[],
  accountName?: (connectionId: string) => string | undefined,
): Map<string, string> {
  const notices = new Map<string, string>();
  let previous: Message | undefined;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const before = previous?.settings;
    const after = message.settings;
    if (before && after && replySettingsChanged(before, after)) {
      const changes = [];
      if (replyAccountChanged(before, after))
        changes.push(`${replyAccountName(message, accountName)} account`);
      if (before.provider !== after.provider || before.model !== after.model)
        changes.push(replyModelName(message));
      if (before.reasoning !== after.reasoning)
        changes.push(`${reasoningName(after.reasoning)} reasoning`);
      notices.set(message.id, `Switched to ${changes.join(' · ')}`);
    }
    previous = message;
  }
  return notices;
}
