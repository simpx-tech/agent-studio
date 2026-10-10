import { messageText, type Conversation } from './domain';
import type { DraftContent } from './drafts';
import { draftImage, type DraftImage } from './images';
import { restoreToDraft, type QueuedMessage } from './queue';

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

/**
 * The message a rewind returns to the composer: its text, its images read back into memory by
 * `read`, and its mentions with the account of the reply that answered it. An image that cannot
 * be read is left out and counted. The conversation is read before any image is.
 */
export async function rewoundMessage(
  conversation: Conversation,
  messageId: string,
  read: (hash: string) => Promise<Blob>,
): Promise<{ message: QueuedMessage; unread: number }> {
  const index = conversation.messages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (index < 0) throw new Error('This message is no longer in the conversation.');
  const sent = conversation.messages[index];
  const reply = conversation.messages.slice(index + 1).find((m) => m.role === 'assistant');
  const text = messageText(sent);
  const mentions = sent.mentions?.map((m) => ({ ...m })) ?? [];
  const connectionId = reply?.settings?.connectionId;
  const attempts = await Promise.all(
    (sent.images ?? []).map((image) => draftImage(image, read).catch(() => undefined)),
  );
  const images = attempts.filter((image): image is DraftImage => !!image);
  return {
    message: {
      id: crypto.randomUUID(),
      text,
      images,
      ...(mentions.length ? { mentions, mentionConnectionId: connectionId } : {}),
    },
    unread: attempts.length - images.length,
  };
}

/**
 * The composer with a rewound message returned ahead of `draft`, as queued messages return after
 * a stopped reply: its text first, its images first. Its mentions stay chosen
 * only while the composer uses the account that answered it, and the draft's own only in the
 * composer's current mention scope; the rest must be chosen again.
 */
export function returnedDraft(
  draft: DraftContent,
  message: QueuedMessage,
  composer: { connectionId?: string; mentionScope: string },
): { draft: DraftContent } {
  const merged = restoreToDraft([message], draft.text, draft.images);
  const inScope = draft.mentionScope === composer.mentionScope;
  const chosen = message.mentionConnectionId === composer.connectionId;
  const returned = message.mentions ?? [];
  return {
    draft: {
      text: merged.draft,
      images: merged.images,
      mentions: [...(inScope ? draft.mentions : []), ...(chosen ? returned : [])],
      staleMentions: [
        ...draft.staleMentions,
        ...(inScope ? [] : draft.mentions.map((m) => m.token)),
        ...(chosen ? [] : returned.map((m) => m.token)),
      ],
      mentionScope: composer.mentionScope,
    },
  };
}

/** Whether a composer still holds what a rewind put there: the same text and images. */
export function sameReturned(
  content: Pick<DraftContent, 'text' | 'images'>,
  returned: Pick<DraftContent, 'text' | 'images'>,
) {
  return (
    content.text === returned.text &&
    content.images.length === returned.images.length &&
    content.images.every((image, i) => image.id === returned.images[i].id)
  );
}
