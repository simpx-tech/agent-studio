import { interruptedReplyError, type Workspace } from './domain';
import {
  attentionKeys,
  chatNotification,
  provisionalAttention,
  type PushNotice,
} from './notifications';

/**
 * How long a question tool may run before its question is recorded. Claude reports
 * AskUserQuestion as it begins, seconds before the question, so its alert waits this long to
 * carry the question, and goes out with the generic line only if none arrives.
 */
export const questionGrace = 5_000;
/** A clock behind another computer's still counts a reply started as this session began. */
const skew = 60_000;

// Snapshots contain only run identities and lifecycle flags, never message text; each
// notice carries its chat's title and a line about the reply.
// The first snapshot is a baseline so opening saved history cannot ring the bell.
// `wake` asks for another snapshot after a delay, when an alert waits for its question.
export function createDesktopNotificationTracker(now = Date.now, wake?: (delay: number) => void) {
  let ready = false;
  const started = now();
  const runs = new Map<string, { terminal: boolean; attention: Set<string>; asked?: number }>();
  return (workspace: Pick<Workspace, 'conversations'>): PushNotice[] => {
    const notices: PushNotice[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const conversation of workspace.conversations) {
      const message = conversation.messages.findLast((m) => m.role === 'assistant');
      if (!message?.runId) continue;
      const old = runs.get(message.runId);
      // A reply restored as interrupted may still be running on another computer, whose copy
      // replaces it on the next sync, so it has not finished until a reply says so.
      const terminal = message.status !== 'running' && message.error !== interruptedReplyError;
      const attention = new Set(old?.attention);
      let asked = old?.asked;
      const created = Date.parse(message.createdAt);
      const fresh = created >= started - skew && created <= now();
      if (ready && (old || fresh)) {
        if (terminal && !old?.terminal) {
          const kind = message.status as 'complete' | 'cancelled' | 'error';
          notices.push({
            kind,
            conversationId: conversation.id,
            tag: `${message.runId}:terminal`,
            ...chatNotification(kind, conversation, message),
          });
        } else if (!terminal && !old?.terminal) {
          const provisional = provisionalAttention(message);
          for (const key of attentionKeys(message)) {
            if (attention.has(key)) continue;
            if (key === 'attention' && provisional) {
              asked ??= now();
              const left = asked + questionGrace - now();
              if (left > 0) {
                soonest = Math.min(soonest, left);
                continue;
              }
            }
            attention.add(key);
            notices.push({
              kind: 'attention',
              conversationId: conversation.id,
              tag: `${message.runId}:${key}`,
              ...chatNotification('attention', conversation, message, key),
            });
          }
        }
      } else for (const key of attentionKeys(message)) attention.add(key);
      // Most recently seen last, so the runs of chats still present are the last to go.
      runs.delete(message.runId);
      runs.set(message.runId, { terminal: terminal || !!old?.terminal, attention, asked });
    }
    ready = true;
    // Bound session memory to more than the chats themselves hold; evicted historical runs
    // also fail the freshness check.
    while (runs.size > Math.max(2048, workspace.conversations.length * 2))
      runs.delete(runs.keys().next().value!);
    if (wake && Number.isFinite(soonest)) wake(soonest);
    return notices;
  };
}
