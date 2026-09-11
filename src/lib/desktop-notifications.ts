import type { Workspace } from './domain';
import { requestsAttention, type PushNotice } from './notifications';

// Snapshots contain only run identities and lifecycle flags, never message text.
// The first snapshot is a baseline so opening saved history cannot ring the bell.
export function createDesktopNotificationTracker(now = Date.now) {
  let ready = false;
  const started = now();
  const runs = new Map<string, { terminal: boolean; attention: boolean }>();
  return (workspace: Pick<Workspace, 'conversations'>): PushNotice[] => {
    const notices: PushNotice[] = [];
    for (const conversation of workspace.conversations) {
      const message = conversation.messages.findLast((m) => m.role === 'assistant');
      if (!message?.runId) continue;
      const old = runs.get(message.runId);
      const terminal = message.status !== 'running';
      const attention = requestsAttention(message);
      const created = Date.parse(message.createdAt);
      const fresh = created >= started && created <= now() && now() - created < 300_000;
      if (ready && (old || fresh)) {
        if (terminal && !old?.terminal)
          notices.push({
            kind: message.status as 'complete' | 'cancelled' | 'error',
            conversationId: conversation.id,
            tag: `${message.runId}:terminal`,
          });
        else if (!terminal && attention && !old?.attention && !old?.terminal)
          notices.push({
            kind: 'attention',
            conversationId: conversation.id,
            tag: `${message.runId}:attention`,
          });
      }
      runs.set(message.runId, {
        terminal: terminal || !!old?.terminal,
        attention: attention || !!old?.attention,
      });
    }
    ready = true;
    // Bound session memory; evicted historical runs also fail the freshness check.
    while (runs.size > 2048) runs.delete(runs.keys().next().value!);
    return notices;
  };
}
