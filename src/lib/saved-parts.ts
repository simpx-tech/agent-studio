/**
 * A saved file's conversations, read and sent a few megabytes at a time.
 *
 * The desktop app keeps the workspace and the sync checkpoint as one file each, with every
 * conversation. The page used to take each as one JSON text when it loaded, and to hand
 * everything back as one whenever a save could name nothing less, which the first save after
 * every start did. A page's JavaScript holds a text of at most 536,870,888 characters and 4 GB in
 * all, and writing the live workspace as text made every part of it reactive besides
 * (src/lib/detached.ts): on 2026-11-13 a 465 MB workspace filled that memory during its first
 * save, the window loaded again, and the next page did the same, in a loop
 * (docs/DIAGNOSTICS.md).
 *
 * So the app hands a file over opened (src-tauri/src/parts.rs): everything but its
 * conversations, with the id and size of each, which the page then reads in lists of about
 * `partBudget` bytes. A save that carries more than one such list sends them ahead, each in a
 * call of its own, under a name its last call gives. Nothing here is a limit: a conversation
 * larger than the budget goes in a list of its own, and there are as many lists as it takes.
 */
import { chatParts, joinBytes, jsonWith, type JsonPart } from './chat-bytes';
import type { Conversation } from './domain';
import { answerBytes } from './window-answers';

/** About how many bytes of JSON one call carries. */
export const partBudget = 16_000_000;

/** What the app answers when a saved file is opened. */
export type Opened =
  /** The file as one value, or `null` when there is none. */
  | { whole: unknown }
  /** The file without its conversations, the id and size of each, and the number reads name. */
  | { parts: OpenedParts };
export type OpenedParts = {
  rest: Record<string, unknown>;
  chats: [id: string, bytes: number][];
  read: number;
};

/** The app's answer to a read of a file that was written since it was opened. */
export const fileMoved = 'The saved file changed while it was read.';

/** The ids each read asks for: about `budget` bytes of conversations, in the file's order. */
export function readBatches(chats: [string, number][], budget = partBudget): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const [id, bytes] of chats) {
    if (batch.length && size + bytes > budget) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(id);
    size += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Reads the conversations of an opened file, a list at a time, as the values their JSON holds.
 * `read` answers the bytes of the JSON list of the conversations it is asked for, and `take`
 * gets each list as it arrives; answering `false` ends the reading there. Returns whether every
 * conversation was read.
 */
export async function readChats(
  chats: [string, number][],
  read: (ids: string[]) => Promise<unknown>,
  take: (conversations: unknown[]) => unknown,
  budget = partBudget,
): Promise<boolean> {
  const decoder = new TextDecoder();
  for (const ids of readBatches(chats, budget)) {
    const list: unknown = JSON.parse(decoder.decode(answerBytes(await read(ids))));
    if (!Array.isArray(list) || list.length !== ids.length)
      throw new Error('The app answered without the conversations asked for.');
    if ((await take(list)) === false) return false;
  }
  return true;
}

/** Some conversations to send in one call: the conversations and the parts of their JSON list. */
export type ChatChunk = { chats: Conversation[]; list: JsonPart[] };

const encoder = new TextEncoder();

/** A conversation's JSON as bytes written now and kept nowhere. */
function writtenOnce(conversation: Conversation): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const text = (part: string) => parts.push(encoder.encode(part));
  // Its other fields, then its messages one at a time: a conversation runs to tens of megabytes.
  const head = jsonWith(conversation, [['messages', []]]);
  const end = head.pop() as string;
  text(`${head.join('')}[`);
  conversation.messages.forEach((message, index) =>
    text(`${index ? ',' : ''}${JSON.stringify(message)}`),
  );
  text(`]${end}`);
  return parts;
}

/**
 * The conversations in lists of about `budget` bytes of JSON, in order, each made as it is asked
 * for. `keep` writes them from the bytes their parts keep (src/lib/chat-bytes.ts), which suits
 * copies that share their unchanged parts from one save to the next; otherwise each is written
 * now and its bytes go with the list, as suits a save of every conversation.
 */
export function* chatChunks(
  chats: Iterable<Conversation>,
  { keep = false, budget = partBudget }: { keep?: boolean; budget?: number } = {},
): Generator<ChatChunk> {
  let chunk: ChatChunk = { chats: [], list: ['['] };
  let size = 0;
  for (const conversation of chats) {
    const parts = keep
      ? chatParts(conversation).map((part) =>
          typeof part === 'string' ? encoder.encode(part) : part,
        )
      : writtenOnce(conversation);
    let bytes = 0;
    for (const part of parts) bytes += part.length;
    if (chunk.chats.length && size + bytes > budget) {
      chunk.list.push(']');
      yield chunk;
      chunk = { chats: [], list: ['['] };
      size = 0;
    }
    if (chunk.chats.length) chunk.list.push(',');
    chunk.chats.push(conversation);
    for (const part of parts) chunk.list.push(part);
    size += bytes;
  }
  if (chunk.chats.length) {
    chunk.list.push(']');
    yield chunk;
  }
}

/**
 * Sends lists of conversations ahead of the call that names them, when one call cannot carry
 * them all: `ahead` sends one list. With at most one list nothing goes ahead, and that list
 * comes back for the caller to send with its own call.
 */
export async function sendAhead(
  chunks: Iterable<ChatChunk>,
  ahead: (chunk: ChatChunk) => Promise<unknown>,
): Promise<{ ahead: true } | { ahead: false; only: ChatChunk | undefined }> {
  let held: ChatChunk | undefined;
  let sent = false;
  for (const chunk of chunks) {
    if (held) {
      await ahead(held);
      sent = true;
    }
    held = chunk;
  }
  if (!sent) return { ahead: false, only: held };
  if (held) await ahead(held);
  return { ahead: true };
}

/**
 * The arguments of a call that sends a list ahead under the name `save`: the bytes of their
 * JSON, or plain values once Tauri carries calls as JSON, where bytes take four times their size.
 */
export const aheadArguments = (save: string, chunk: ChatChunk, plain: boolean) =>
  plain ? { save, upsert: chunk.chats } : joinBytes(jsonWith({ save }, [['upsert', chunk.list]]));
