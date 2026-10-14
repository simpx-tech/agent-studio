/**
 * Conversations as the bytes of their JSON, written once per part.
 *
 * Sending a conversation to the relay or to this computer's storage used to write all of it as
 * text each time: Tauri serializes a call's arguments with `JSON.stringify` and a function that
 * visits every value, then encodes the text, and the app parsed it again on its window thread.
 * Copies of a conversation share the messages and calls that did not change
 * (src/lib/chat-snapshots.ts), so each part's bytes are kept with the part and a body is put
 * together by copying them, with only what changed written anew. The app takes the same
 * arguments as those bytes (`sentAsBytes` here, `calls::sent` there) and reads them off its
 * window thread.
 *
 * Bytes are kept by object, so give these functions detached copies that nothing edits, never
 * live conversations.
 */
import type { ContentBlock, Conversation, Message } from './domain';

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);
const kept = new WeakMap<object, Uint8Array>();

/** The JSON of a value as bytes, kept with it when it is an object. */
function written(value: unknown): Uint8Array {
  const object = typeof value === 'object' && value !== null ? value : undefined;
  const before = object && kept.get(object);
  if (before) return before;
  // An array item JSON cannot write is `null`, as `JSON.stringify` writes it.
  const bytes = encode(JSON.stringify(value) ?? 'null');
  if (object) kept.set(object, bytes);
  return bytes;
}

/** A piece of JSON text, or bytes already written. */
export type JsonPart = string | Uint8Array;

/** One buffer holding the parts in order. */
export function joinBytes(parts: JsonPart[]): Uint8Array {
  const pieces = parts.map((part) => (typeof part === 'string' ? encode(part) : part));
  let length = 0;
  for (const piece of pieces) length += piece.length;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.length;
  }
  return bytes;
}

/** `[a,b,c]` from the parts of each item. */
function listed(items: JsonPart[][]): JsonPart[] {
  const parts: JsonPart[] = ['['];
  items.forEach((item, index) => {
    if (index) parts.push(',');
    parts.push(...item);
  });
  parts.push(']');
  return parts;
}

/**
 * An object's JSON with the named fields written from `fields` instead, after its own, so a body
 * is put together around parts already written. The order of an object's keys carries no meaning
 * for anything that reads these bytes: the relay and this app validate what they parse.
 */
export function jsonWith(
  object: Record<string, unknown>,
  fields: [string, JsonPart[]][],
): JsonPart[] {
  const rest: Record<string, unknown> = { ...object };
  for (const [name] of fields) delete rest[name];
  const head = JSON.stringify(rest);
  const parts: JsonPart[] = [head.slice(0, -1)];
  let first = head === '{}';
  for (const [name, value] of fields) {
    parts.push(`${first ? '' : ','}${JSON.stringify(name)}:`, ...value);
    first = false;
  }
  parts.push('}');
  return parts;
}

// The fields of a message kept apart from the rest of it, each written once.
const apart = ['fileChanges', 'visualizations'] as const;

function messageParts(message: Message): JsonPart[] {
  const fields: [string, JsonPart[]][] = [];
  for (const name of apart) {
    const value = message[name];
    if (value !== undefined) fields.push([name, [written(value)]]);
  }
  fields.push(['blocks', listed(message.blocks.map((block: ContentBlock) => [written(block)]))]);
  return jsonWith(message, fields);
}

/** A message's JSON as bytes. */
function messageBytes(message: Message): Uint8Array {
  const before = kept.get(message);
  if (before) return before;
  // A reply still running is put together from its parts each time it grows, and so is one that
  // just ended, whose parts are written already. Any other message is written whole, once,
  // without bytes of its own for each block.
  const growing =
    message.status === 'running' || message.blocks.some((block: ContentBlock) => kept.has(block));
  const bytes = growing ? joinBytes(messageParts(message)) : written(message);
  kept.set(message, bytes);
  return bytes;
}

/** A conversation's JSON, as parts to join into a body. */
export function chatParts(conversation: Conversation): JsonPart[] {
  return jsonWith(conversation, [
    ['messages', listed(conversation.messages.map((message) => [messageBytes(message)]))],
  ]);
}

/** How many bytes a conversation's JSON takes. */
export function chatSize(conversation: Conversation): number {
  let size = 0;
  for (const part of chatParts(conversation))
    size += typeof part === 'string' ? encode(part).length : part.length;
  return size;
}

/** The JSON list of these conversations, as parts to join into a body. */
export const chatList = (chats: Conversation[]): JsonPart[] => listed(chats.map(chatParts));
