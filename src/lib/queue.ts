import type { SkillReference } from './domain';
import type { Mention } from './mentions';
import type { ChatImage } from './images';

/**
 * Messages written while a reply is still running. Each conversation keeps its own
 * session-only queue: nothing here is saved, exported, or relayed. After a completed
 * reply the next queued message is sent; a stopped or failed reply returns them to the
 * composer instead.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  images: ChatImage[];
  skills?: SkillReference[];
  mentions?: Mention[];
  mentionConnectionId?: string;
};

export const maxQueuedMessages = 8;

export function enqueueMessage(
  queue: QueuedMessage[],
  message: Omit<QueuedMessage, 'id'> & { id?: string },
): { queue: QueuedMessage[]; error?: string } {
  const text = message.text.trim();
  if (!text && !message.images.length) return { queue, error: 'Enter a message first.' };
  if (queue.length >= maxQueuedMessages)
    return {
      queue,
      error: `Up to ${maxQueuedMessages} messages can wait for the current reply. Stop the reply or wait for it to finish.`,
    };
  return {
    queue: [
      ...queue,
      {
        id: message.id ?? crypto.randomUUID(),
        text,
        images: [...message.images],
        ...(message.skills?.length ? { skills: [...message.skills] } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions.map((m) => ({ ...m })) } : {}),
        ...(message.mentions?.length ? { mentionConnectionId: message.mentionConnectionId } : {}),
      },
    ],
  };
}

/** Return queued messages to the composer, oldest first and ahead of the current draft. */
export function restoreToDraft(
  queue: QueuedMessage[],
  draft: string,
  images: ChatImage[],
  maxImages: number,
): { draft: string; images: ChatImage[]; droppedImages: number } {
  const texts = queue.map((message) => message.text.trim()).filter(Boolean);
  const merged = [...texts, draft.trim()].filter(Boolean).join('\n\n');
  const all = [...queue.flatMap((message) => message.images), ...images];
  const kept = all.slice(0, Math.max(0, maxImages));
  return { draft: merged, images: kept, droppedImages: all.length - kept.length };
}

export function queuedPreview(message: QueuedMessage, limit = 120): string {
  const text = message.text.replace(/\s+/g, ' ').trim();
  const label = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  const count = message.images.length;
  const images = count ? ` (${count} image${count === 1 ? '' : 's'})` : '';
  return `${label || 'Image message'}${images}`;
}
