import { type Conversation, type Workspace } from './domain';

// A fork ends at a finished reply. Never copy the user input or partial output
// belonging to an in-flight turn, even when later malformed history exists.
export function forkPoint(conversation: Conversation, messageId?: string): number {
  let last = -1;
  for (const [index, message] of conversation.messages.entries()) {
    if (message.status === 'running') break;
    if (message.role === 'assistant') {
      if (messageId === message.id) return index;
      last = index;
    }
  }
  return messageId ? -1 : last;
}

export function forkConversation(source: Conversation, messageId?: string): Conversation {
  const end = forkPoint(source, messageId);
  if (end < 0) throw new Error('A finished reply is needed to fork this conversation.');
  const messages = structuredClone(source.messages.slice(0, end + 1));
  for (const message of messages) {
    message.id = crypto.randomUUID();
    // Run IDs describe historical evidence, not a live execution binding. Keep
    // them with their recorded usage/steering, but never revive answer channels.
    for (const question of message.questions ?? []) {
      if (question.status === 'pending') {
        question.status = 'cancelled';
        question.revision = 3;
        delete question.response;
      }
    }
  }
  const now = new Date().toISOString();
  const title = source.title.slice(0, 93).replace(/[\uD800-\uDBFF]$/, '');
  return {
    id: crypto.randomUUID(),
    forked: true,
    title: `${title} (fork)`,
    titleStatus: 'generated',
    settings: structuredClone(
      messageId ? (source.messages[end].settings ?? source.settings) : source.settings,
    ),
    ...(source.location ? { location: structuredClone(source.location) } : {}),
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

export function forkFitsWorkspace(workspace: Workspace, fork: Conversation): boolean {
  // Use the same byte limit as native storage and the relay. Check before
  // inserting the copy, so a large image history cannot make saves fail.
  return (
    new TextEncoder().encode(
      JSON.stringify({ ...workspace, conversations: [fork, ...workspace.conversations] }),
    ).length <= 20_000_000
  );
}
