import type { ChatSettings, Conversation, Message, SkillReference } from './domain';
import type { Mention } from './mentions';
import type { DraftImage } from './images';

/**
 * Messages written while a reply is still running. Each conversation keeps its own
 * session-only queue: nothing here is saved, exported, or relayed. After a completed
 * reply the next queued message is sent; a stopped or failed reply returns them to the
 * composer instead.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  images: DraftImage[];
  skills?: SkillReference[];
  mentions?: Mention[];
  mentionConnectionId?: string;
};

export function enqueueMessage(
  queue: QueuedMessage[],
  message: Omit<QueuedMessage, 'id'> & { id?: string },
): { queue: QueuedMessage[]; error?: string } {
  const text = message.text.trim();
  if (!text && !message.images.length) return { queue, error: 'Enter a message first.' };
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
  images: DraftImage[],
): { draft: string; images: DraftImage[] } {
  const texts = queue.map((message) => message.text.trim()).filter(Boolean);
  const merged = [...texts, draft.trim()].filter(Boolean).join('\n\n');
  return { draft: merged, images: [...queue.flatMap((message) => message.images), ...images] };
}

/**
 * The running Claude reply whose next queued message may go now, with the idle stretch it waits
 * in. Its turn ended while background work it waits for continues, so the CLI is idle: it hands
 * its process to the next reply, which answers at once and goes on waiting for that work. Only
 * the same account and launch settings keep that process, so other settings wait for the reply
 * as before, as does a message the reply refused during this stretch. What this window heard
 * from the reply's own events (`heard`, null once a turn started) comes before the saved field,
 * which a synced copy can hold late, or lack on an older relay.
 */
export function takeOverTarget(
  conversation: Conversation,
  refused: Readonly<Record<string, number>> = {},
  heard: Readonly<Record<string, number | null>> = {},
): { reply: Message; wait: number } | undefined {
  const reply = conversation.messages.at(-1);
  if (
    reply?.role !== 'assistant' ||
    reply.status !== 'running' ||
    !reply.runId ||
    reply.compact ||
    reply.settings?.provider !== 'claude' ||
    !sameProcess(reply.settings, conversation.settings)
  )
    return;
  const known = heard[reply.runId];
  const wait = known === undefined ? reply.backgroundWait : known;
  if (!wait || refused[reply.runId] === wait) return;
  return { reply, wait };
}

/**
 * Whether a Claude reply with `next` settings keeps the process of one with `previous` ones.
 * The model and thinking budget change in the running process; the rest needs a new one.
 */
export function sameProcess(previous: ChatSettings, next: ChatSettings): boolean {
  return (
    previous.provider === next.provider &&
    previous.connectionId === next.connectionId &&
    previous.reasoning === next.reasoning &&
    !!previous.planMode === !!next.planMode &&
    previous.fastMode === next.fastMode &&
    (previous.fallbackModel ?? '') === (next.fallbackModel ?? '') &&
    (previous.outputSchema ?? '') === (next.outputSchema ?? '') &&
    previous.autoCompactTokens === next.autoCompactTokens
  );
}

export function queuedPreview(message: QueuedMessage, limit = 120): string {
  const text = message.text.replace(/\s+/g, ' ').trim();
  const label = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  const count = message.images.length;
  const images = count ? ` (${count} image${count === 1 ? '' : 's'})` : '';
  return `${label || 'Image message'}${images}`;
}
