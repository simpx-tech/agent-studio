import type { Workspace } from './domain';
import { attentionKeys, chatNotification, type PushNotice } from './notifications';

// Snapshots contain only run identities and lifecycle flags, never message text; each
// notice carries its chat's title and a line about the reply.
// The first snapshot is a baseline so opening saved history cannot ring the bell.
export function createDesktopNotificationTracker(now = Date.now) {
  let ready = false;
  const started = now();
  const runs = new Map<string, { terminal: boolean; attention: Set<string> }>();
  return (workspace: Pick<Workspace, 'conversations'>): PushNotice[] => {
    const notices: PushNotice[] = [];
    for (const conversation of workspace.conversations) {
      const message = conversation.messages.findLast((m) => m.role === 'assistant');
      if (!message?.runId) continue;
      const old = runs.get(message.runId);
      const terminal = message.status !== 'running';
      const attention = attentionKeys(message);
      const created = Date.parse(message.createdAt);
      const fresh = created >= started && created <= now() && now() - created < 300_000;
      if (ready && (old || fresh)) {
        if (terminal && !old?.terminal) {
          const kind = message.status as 'complete' | 'cancelled' | 'error';
          notices.push({
            kind,
            conversationId: conversation.id,
            tag: `${message.runId}:terminal`,
            ...chatNotification(kind, conversation, message),
          });
        } else if (!terminal && !old?.terminal)
          for (const key of attention.filter((key) => !old?.attention.has(key)))
            notices.push({
              kind: 'attention',
              conversationId: conversation.id,
              tag: `${message.runId}:${key}`,
              ...chatNotification('attention', conversation, message, key),
            });
      }
      runs.set(message.runId, {
        terminal: terminal || !!old?.terminal,
        attention: new Set([...(old?.attention ?? []), ...attention]),
      });
    }
    ready = true;
    // Bound session memory; evicted historical runs also fail the freshness check.
    while (runs.size > 2048) runs.delete(runs.keys().next().value!);
    return notices;
  };
}
