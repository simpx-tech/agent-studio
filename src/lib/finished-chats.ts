import type { Conversation, Message } from './domain';

type Reply = Pick<Message, 'role' | 'status' | 'runId' | 'createdAt'>;
type Chat = Pick<Conversation, 'id'> & { messages: readonly Reply[] };
/** The finished run each chat has not been read since, by conversation. */
export type FinishedChats = Record<string, string>;

// A reply that appeared and ended between two updates is still news; an older one is history.
const freshWindow = 300_000;

/**
 * Sidebar marks for chats whose reply finished while the reader was looking elsewhere.
 * Reading belongs to the window that did it, so marks stay in memory here: never saved,
 * exported or synced. The first snapshot is a baseline, so restored history and replies that
 * ended before this session are never marked, and each mark names the run that finished, so
 * another reply, a rewritten history or a deleted chat drops it. The marks given are left
 * untouched, and returned unchanged when nothing moved.
 */
export function createFinishedChatTracker(now = Date.now) {
  let ready = false;
  const started = now();
  // Whether each run was already seen finished. Bounded like lifecycle alerts.
  const runs = new Map<string, boolean>();
  return (chats: readonly Chat[], marked: FinishedChats, open?: string): FinishedChats => {
    let next = marked;
    const change = () => (next === marked ? (next = { ...marked }) : next);
    const present = new Set<string>();
    for (const chat of chats) {
      present.add(chat.id);
      const reply = chat.messages.findLast((m) => m.role === 'assistant');
      const runId = reply?.runId;
      // Only a mark for the reply a reader would meet now survives.
      let unread = runId && marked[chat.id] === runId ? runId : undefined;
      if (reply && runId) {
        const finished = reply.status !== 'running';
        const seen = runs.get(runId);
        const created = Date.parse(reply.createdAt);
        const fresh = created >= started && created <= now() && now() - created < freshWindow;
        if (finished && ready && !seen && (seen !== undefined || fresh) && chat.id !== open)
          unread = runId;
        runs.set(runId, finished || !!seen);
      }
      if (unread === marked[chat.id]) continue;
      if (unread) change()[chat.id] = unread;
      else delete change()[chat.id];
    }
    // A chat this device no longer holds takes its mark along.
    for (const id of Object.keys(marked)) if (!present.has(id)) delete change()[id];
    ready = true;
    // Bound session memory; evicted historical runs also fail the freshness check.
    while (runs.size > 2048) runs.delete(runs.keys().next().value!);
    return next;
  };
}
