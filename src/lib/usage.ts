import {
  historyFor,
  messageText,
  type ChatSettings,
  type Conversation,
  type RunRequest,
} from './domain';
import type { ModelInfo } from './models';

export type LimitWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | number | null;
  windowMinutes: number | null;
  model: string | null;
  bucket: string;
};
export type UsageSnapshot = {
  connectionId?: string;
  provider: string;
  checkedAt: number;
  windows: LimitWindow[];
  context: { model: string; tokens: number; source: string } | null;
  detail: string;
};
export const usageKey = (settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'>) =>
  `${settings.provider}:${settings.model}${settings.connectionId ? `:${settings.connectionId}` : ''}`;
export function snapshotFor(
  snapshots: Record<string, UsageSnapshot>,
  settings: ChatSettings,
): UsageSnapshot | undefined {
  const exact = snapshots[usageKey(settings)];
  let latest = exact;
  for (const snapshot of Object.values(snapshots)) {
    if (
      snapshot.provider === settings.provider &&
      snapshot.connectionId === settings.connectionId &&
      (!latest || snapshot.checkedAt > latest.checkedAt)
    )
      latest = snapshot;
  }
  // Account quotas belong to the provider; context capacities belong to the selected model.
  return latest ? { ...latest, context: exact?.context ?? null } : undefined;
}
export const compactTokens = (n: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const percentage = (n: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n)}%`;
export function resetTime(value: LimitWindow['resetsAt']): number | null {
  const time = typeof value === 'number' ? value * 1000 : value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}
export function resetLabel(value: LimitWindow['resetsAt'], now: number): string {
  const time = resetTime(value);
  if (!time) return 'Reset time not reported';
  const minutes = Math.ceil((time - now) / 60_000);
  if (minutes <= 0) return 'Reset due · awaiting update';
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
export function isFable(settings: ChatSettings, snapshot?: UsageSnapshot) {
  return (
    settings.provider === 'claude' &&
    /fable/i.test(settings.model || snapshot?.context?.model || '')
  );
}
export function visibleLimits(
  snapshot: UsageSnapshot | undefined,
  settings: ChatSettings,
): (LimitWindow & { available: boolean })[] {
  let windows = snapshot?.windows ?? [];
  if (settings.provider === 'codex') {
    const scoped = windows.filter(
      (w) =>
        w.model &&
        settings.model.toLowerCase().includes('spark') &&
        w.model.toLowerCase().includes('spark'),
    );
    windows = scoped.length ? scoped : windows.filter((w) => w.bucket === 'codex');
  }
  const expected = [
    { id: 'five-hour', label: '5-hour', minutes: 300, model: null },
    { id: 'weekly', label: 'Weekly', minutes: 10080, model: null },
    ...(isFable(settings, snapshot)
      ? [{ id: 'fable-weekly', label: 'Fable weekly', minutes: 10080, model: 'fable' }]
      : []),
  ];
  return expected.map((e) => {
    const window = windows.find(
      (w) =>
        w.windowMinutes === e.minutes &&
        (e.model ? w.model?.toLowerCase() === e.model : !w.model || settings.provider === 'codex'),
    );
    return window
      ? { ...window, available: window.usedPercent != null }
      : {
          id: e.id,
          label: e.label,
          windowMinutes: e.minutes,
          model: e.model,
          usedPercent: null,
          resetsAt: null,
          bucket: settings.provider,
          available: false,
        };
  });
}
export function isStale(snapshot: UsageSnapshot | undefined, window: LimitWindow, now: number) {
  if (!snapshot) return false;
  const reset = resetTime(window.resetsAt);
  return (
    now - snapshot.checkedAt * 1000 > 180_000 ||
    (reset != null && now >= reset && snapshot.checkedAt * 1000 < reset)
  );
}
export function estimatePromptTokens(
  settings: ChatSettings,
  messages: RunRequest['messages'],
): number {
  // Explicit estimate, not a tokenizer. UTF-8 handles non-Latin text better than JS length.
  const body = JSON.stringify({
    agent_instructions: settings.instructions,
    conversation: messages,
  });
  return 85 + Math.ceil(new TextEncoder().encode(body).length / 4);
}
export function contextFor(
  conversation: Conversation | undefined,
  settings: ChatSettings,
  draft: string,
  model: ModelInfo,
  snapshot?: UsageSnapshot,
) {
  const history = conversation ? historyFor(conversation) : [];
  const streaming = conversation?.messages.findLast(
    (m) => m.role === 'assistant' && m.status === 'running',
  );
  if (streaming && messageText(streaming))
    history.push({ role: 'assistant', text: messageText(streaming) });
  const withoutDraft = estimatePromptTokens(settings, history);
  if (draft.trim()) history.push({ role: 'user', text: draft.trim() });
  const withDraft = estimatePromptTokens(settings, history);
  const sameSettings = (other?: ChatSettings) =>
    other?.provider === settings.provider &&
    other.model === settings.model &&
    other.reasoning === settings.reasoning &&
    other.instructions === settings.instructions;
  // A pending reply keeps the last reading until it supplies a new one. A later
  // finished reply with missing usage must not silently revive an older reading.
  const latest = conversation?.messages.findLast(
    (m) => m.role === 'assistant' && (m.status !== 'running' || m.usage?.contextInput != null),
  );
  const compatible = sameSettings(latest?.settings);
  const reported = compatible ? (latest?.usage?.contextInput ?? null) : null;
  const measuredCapacity = reported != null ? latest?.usage?.contextWindow : null;
  const previous = conversation?.messages.findLast(
    (m) =>
      m.role === 'assistant' &&
      sameSettings(m.settings) &&
      m.promptTokensEstimate != null &&
      (m.usage?.contextInput != null || m.usage?.input != null),
  );
  const lastInput = previous?.usage?.contextInput ?? previous?.usage?.input ?? null;
  const overhead = lastInput != null ? Math.max(0, lastInput - previous!.promptTokensEstimate!) : 0;
  const estimated = withDraft + overhead;
  const nextCapacity =
    snapshot?.context?.tokens ?? model.contextWindow ?? previous?.usage?.contextWindow ?? null;
  const capacity = measuredCapacity ?? nextCapacity;
  const source = measuredCapacity
    ? 'Window reported with this response'
    : (snapshot?.context?.source ??
      model.contextSource ??
      (previous?.usage?.contextWindow ? 'Last provider response' : 'Capacity not reported'));
  return {
    reported,
    reportedModel: reported != null ? (latest?.usage?.model ?? settings.model) : null,
    unavailableReason: !latest
      ? 'Send a message to get the first provider reading.'
      : !compatible
        ? 'Send a message with these settings to measure its context.'
        : 'This reply did not include a request-level context reading.',
    estimated,
    nextCapacity,
    estimatedPercent: nextCapacity && nextCapacity > 0 ? (estimated / nextCapacity) * 100 : null,
    draftTokens: Math.max(0, withDraft - withoutDraft),
    capacity,
    source,
    percent: reported != null && capacity && capacity > 0 ? (reported / capacity) * 100 : null,
    calibrated: lastInput != null,
    lastInput,
    draftIncluded: !!draft.trim(),
    streaming: !!streaming,
  };
}
export function recordedUsage(conversation?: Conversation) {
  let input = 0,
    output = 0,
    cached = 0,
    reasoning = 0,
    inputMeasured = 0,
    outputMeasured = 0,
    measured = 0,
    missing = 0;
  for (const message of conversation?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const u = message.usage;
    if (u?.input == null || u?.output == null) missing++;
    if (u?.input == null && u?.output == null) continue;
    measured++;
    if (u.input != null) inputMeasured++;
    if (u.output != null) outputMeasured++;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cached += u.cachedInput ?? 0;
    reasoning += u.reasoningOutput ?? 0;
  }
  return { input, output, cached, reasoning, measured, inputMeasured, outputMeasured, missing };
}
