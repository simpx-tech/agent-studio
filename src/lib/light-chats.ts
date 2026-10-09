import type { ContentBlock, Conversation, Message } from './domain';
import { mergeActivityBlocks } from './activity.ts';

/**
 * Light chats for the Viewer (docs/MOBILE.md). Almost all of a workspace is the record of each
 * reply's work: its tool calls, reasoning and file diffs (57 of 59 MB on 2026-10-09). A light
 * message leaves those out and keeps everything else, including its text (the markdown blocks),
 * so a phone can list, search and sync every chat while holding only the one it shows in full.
 * A recorded reply never loses that work once it has it, which is what lets the relay put it
 * back into a light upload (`restoreChat`) instead of storing the upload as it came.
 */
const heavy = (block: ContentBlock) => block.type !== 'markdown';
const text = (blocks: ContentBlock[]) =>
  blocks.flatMap((block) => (block.type === 'markdown' ? [block.text] : []));
const sameText = (a: ContentBlock[], b: ContentBlock[]) => {
  const left = text(a),
    right = text(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/** Whether two copies of a message hold the same text. */
export const sameMarkdown = (a: Message, b: Message) => sameText(a.blocks, b.blocks);

/**
 * A cheap fingerprint of a message's recorded work: recorded calls and reasoning change only with
 * a higher revision, so a copy with the same one shows the same work.
 */
export function workSignature(message: Message): string {
  let revisions = 0;
  for (const block of message.blocks)
    revisions +=
      block.type === 'markdown'
        ? block.text.length
        : block.type === 'reasoning'
          ? block.revision + 1
          : (block.tool?.revision ?? 0) + (block.progress?.revision ?? 0) + 1;
  return `${message.blocks.length}:${revisions}:${message.fileChanges?.revision ?? 0}`;
}

/** Whether a message holds none of a reply's recorded work. */
export const isLightMessage = (message: Message) =>
  !message.fileChanges && !message.blocks.some(heavy);

export function lightMessage(message: Message): Message {
  if (isLightMessage(message)) return message;
  const { fileChanges, ...rest } = message;
  return { ...rest, blocks: message.blocks.filter((block) => !heavy(block)) };
}

/**
 * The conversation with its messages light, those removed by a rewind included. `keep` names the
 * messages to leave whole, such as a fork's, which nothing else holds yet. Returns the conversation
 * itself when nothing in it was heavy.
 */
export function lightChat(
  conversation: Conversation,
  keep?: (message: Message) => boolean,
): Conversation {
  const light = (message: Message) => (keep?.(message) ? message : lightMessage(message));
  const messages = conversation.messages.map(light);
  const removed = conversation.rewind?.removed.map(light);
  const changed =
    messages.some((message, index) => message !== conversation.messages[index]) ||
    !!removed?.some((message, index) => message !== conversation.rewind!.removed[index]);
  if (!changed) return conversation;
  return {
    ...conversation,
    messages,
    ...(conversation.rewind ? { rewind: { ...conversation.rewind, removed: removed! } } : {}),
  };
}

/**
 * The message with the recorded work another copy of it holds, where it has none of its own: the
 * same blocks when its text is that copy's, and otherwise its own text with that copy's calls and
 * reasoning added, as two copies of a reply merge (`mergeActivityBlocks`). File changes come back
 * whenever the message has none. Returns the message itself when there is nothing to add.
 */
export function restoreMessage(message: Message, source: Message | undefined): Message {
  if (!source || source.id !== message.id || source === message) return message;
  const blocks =
    message.blocks.some(heavy) || !source.blocks.some(heavy)
      ? message.blocks
      : sameText(message.blocks, source.blocks)
        ? source.blocks
        : mergeActivityBlocks(message.blocks, source.blocks);
  const fileChanges = message.fileChanges ?? source.fileChanges;
  if (blocks === message.blocks && fileChanges === message.fileChanges) return message;
  return { ...message, blocks, ...(fileChanges ? { fileChanges } : {}) };
}

/**
 * The conversation with each message's recorded work restored from `find`, which names another copy
 * of a message by its id, the messages a rewind removed included. Returns the conversation itself
 * when nothing was restored.
 */
export function restoreChat(
  conversation: Conversation,
  find: (id: string) => Message | undefined,
): Conversation {
  const restore = (message: Message) => restoreMessage(message, find(message.id));
  const messages = conversation.messages.map(restore);
  const removed = conversation.rewind?.removed.map(restore);
  const changed =
    messages.some((message, index) => message !== conversation.messages[index]) ||
    !!removed?.some((message, index) => message !== conversation.rewind!.removed[index]);
  if (!changed) return conversation;
  return {
    ...conversation,
    messages,
    ...(conversation.rewind ? { rewind: { ...conversation.rewind, removed: removed! } } : {}),
  };
}

/** The ids of the messages holding recorded work, those a rewind removed included. */
export function workIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>();
  for (const message of [...conversation.messages, ...(conversation.rewind?.removed ?? [])])
    if (!isLightMessage(message)) ids.add(message.id);
  return ids;
}
/** Whether any message of the conversation holds recorded work. */
export const holdsWork = (conversation: Conversation) => workIds(conversation).size > 0;

/** The ids of every message of these conversations, those a rewind removed included. */
export function messageIds(conversations: Iterable<Conversation>): Set<string> {
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) ids.add(message.id);
    for (const message of conversation.rewind?.removed ?? []) ids.add(message.id);
  }
  return ids;
}

/** Every message of these conversations by id, those a rewind removed included. */
export function messagesById(conversations: Iterable<Conversation>): Map<string, Message> {
  const found = new Map<string, Message>();
  for (const conversation of conversations)
    for (const message of [...conversation.messages, ...(conversation.rewind?.removed ?? [])])
      if (!found.has(message.id)) found.set(message.id, message);
  return found;
}
