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

// Tenths of a second only matter under a minute; longer times round to whole seconds.
export function formatReplyTime(durationMs: number): string {
  const tenths = Math.round(durationMs / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}h ` : ''}${minutes}m ${seconds % 60}s`;
}

// claude-opus-5-5 reads as Opus 5.5 and claude-haiku-4-5-20251001 as Haiku 4.5, without a
// provider prefix (us.anthropic.), snapshot date or context suffix ([1m]), as the Claude
// catalog names them in src-tauri/src/models.rs.
function claudeModelName(id: string): string | undefined {
  const base = id.split(/[[@:]/)[0];
  const start = base.indexOf('claude-');
  if (start < 0) return undefined;
  const parts = base.slice(start + 'claude-'.length).split('-');
  if (/^\d{8}$/.test(parts.at(-1) ?? '')) parts.pop();
  const [family, ...version] = parts;
  if (!/^[a-z]+$/.test(family) || !version.length || !version.every((p) => /^\d{1,2}$/.test(p)))
    return undefined;
  return `${family[0].toUpperCase()}${family.slice(1)} ${version.join('.')}`;
}

export function formatModelName(id: string): string {
  if (!id) return 'CLI default';
  const claude = claudeModelName(id);
  if (claude) return claude;
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

// A resolved Claude name: Opus 5.5, never CLI default or an unresolved Opus.
const versionedClaudeName = /^[A-Z][a-z]+ \d+(?:\.\d+)*$/;

/** A Claude reply that ran another model than the one the picker named when it was sent, such
 * as an older CLI resolving an alias to an older model or a fallback model answering. Replies
 * sent before the picker named versions have nothing to compare and stay quiet. */
export function replyModelMismatch(message: Message): { picked: string; ran: string } | undefined {
  const reported = message.usage?.model;
  const picked = message.modelName;
  if (message.settings?.provider !== 'claude' || !reported || !picked) return undefined;
  if (reported === message.settings.model) return undefined;
  const ran = formatModelName(reported);
  return versionedClaudeName.test(picked) && versionedClaudeName.test(ran) && picked !== ran
    ? { picked, ran }
    : undefined;
}

// Older snapshots may lack a connection; only two recorded connections can differ.
export function replyAccountChanged(previous: ChatSettings, next: ChatSettings): boolean {
  return (
    !!previous.connectionId && !!next.connectionId && previous.connectionId !== next.connectionId
  );
}

export function replySettingsChanged(previous: ChatSettings, next: ChatSettings): boolean {
  return (
    previous.provider !== next.provider ||
    previous.model !== next.model ||
    previous.reasoning !== next.reasoning ||
    !!previous.planMode !== !!next.planMode ||
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
      if (!!before.planMode !== !!after.planMode)
        changes.push(after.planMode ? 'Plan mode' : 'Build mode');
      notices.set(message.id, `Switched to ${changes.join(' · ')}`);
    }
    previous = message;
  }
  return notices;
}
