import type { Conversation } from './domain';

function idle(conversation: Conversation) {
  if (conversation.messages.some((m) => m.status === 'running'))
    throw new Error('Wait for the response to finish or stop it before rewinding.');
}

/** Keep the removed suffix intact, including images and recorded response metadata. */
export function rewindConversation(conversation: Conversation, messageId: string): Conversation {
  idle(conversation);
  const index = conversation.messages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (index < 0) throw new Error('This message is no longer in the conversation.');
  const removed = [...conversation.messages.slice(index), ...(conversation.rewind?.removed ?? [])];
  if (removed.length > 200) throw new Error('This rewind exceeds the saved history limit.');
  const now = new Date().toISOString();
  return {
    ...conversation,
    messages: conversation.messages.slice(0, index),
    historyRevision: (conversation.historyRevision ?? 0) + 1,
    rewind: { removed, createdAt: now },
    updatedAt: now,
  };
}

export function undoRewind(conversation: Conversation): Conversation {
  idle(conversation);
  if (!conversation.rewind) throw new Error('There is no rewind to undo.');
  const { rewind, ...rest } = conversation;
  return {
    ...rest,
    messages: [...conversation.messages, ...rewind.removed],
    historyRevision: (conversation.historyRevision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}
