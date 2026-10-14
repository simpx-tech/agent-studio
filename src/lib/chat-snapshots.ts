/**
 * Copies of live conversations for syncing and saving, each sharing with the copy before it
 * every message and call that did not change.
 *
 * A conversation holds everything its replies recorded, and a long one runs to megabytes: the
 * largest here on 2026-10-13 held 10,038 calls in 9.8 MB. While a reply ran in it, every relay
 * poll validated all of it again, compared whole copies as JSON text and wrote all of it for the
 * upload, 430 ms of blocked page each time (docs/PERFORMANCE.md). A reply changes its own message
 * and a few of its calls between two polls, so a copy made here costs what changed: the rest is
 * the same objects as before, which a comparison passes over at once (`jsonEqual`) and whose
 * bytes are already written (src/lib/chat-bytes.ts).
 *
 * A copy equals `conversationSchema.parse(conversation)`, the detached and validated form the
 * sync code has always read. It reuses:
 * - a message nobody touched since the last copy, without reading it. Callers say what changed
 *   (`touch`); a change that names no message makes the next copy read every message again.
 * - a block of a message that was read, when each of its fields is the value it held when its
 *   copy was made. A reply replaces a call's record or a comment's text; it never edits inside
 *   one.
 * - a message's file changes and visuals on the same terms, since those run to megabytes too.
 *
 * So parts are replaced, never edited in place: `message.usage = { ...message.usage, … }`, not
 * `message.usage.contextInput = …`. `verify` checks every copy against a full parse, which the
 * tests turn on.
 */
import {
  blockSchema,
  conversationSchema,
  messageSchema,
  type ContentBlock,
  type Conversation,
  type Message,
} from './domain';
import { jsonEqual } from './json-equal';

/** Message fields that can hold megabytes and are replaced whole. */
const heavy = ['fileChanges', 'visualizations', 'artifacts'] as const;
const messageFields = Object.keys(messageSchema.shape);
// The fields of each kind of block, by its `type`.
const blockFields = new Map<unknown, string[]>(
  blockSchema.options.map((option) => [option.shape.type.value, Object.keys(option.shape)]),
);

type Fields = Record<string, unknown>;
type BlockCopy = { copy: ContentBlock; values: unknown[] };
type MessageCopy = {
  /** The live message the copy was made from. */
  live: Message;
  copy: Message;
  /** The live value each heavy field was copied from, with its copy. */
  heavy: Record<string, { from: unknown; copy: unknown }>;
};
type ChatCopies = {
  messages: Map<string, MessageCopy>;
  /** The messages touched since the last copy, or `undefined` when every one may have changed. */
  touched: Set<string> | undefined;
};

export type ChatSnapshots = ReturnType<typeof createChatSnapshots>;

export function createChatSnapshots(options: { verify?: boolean } = {}) {
  const chats = new Map<string, ChatCopies>();
  // A block's copy lives as long as the block does.
  const blocks = new WeakMap<object, BlockCopy>();

  function readBlock(live: ContentBlock): ContentBlock {
    const fields =
      live && typeof live === 'object' ? blockFields.get((live as Fields).type) : undefined;
    if (!fields) return blockSchema.parse(live);
    const source = live as Fields;
    const kept = blocks.get(live);
    if (kept) {
      let same = true;
      for (let index = 0; index < fields.length; index++)
        if (source[fields[index]] !== kept.values[index]) {
          same = false;
          break;
        }
      if (same) return kept.copy;
    }
    const values = fields.map((field) => source[field]);
    const copy = blockSchema.parse(live);
    blocks.set(live, { copy, values });
    return copy;
  }

  function readMessage(live: Message, before?: MessageCopy): MessageCopy {
    const list = (live as Fields | null)?.blocks;
    // Left to the schema to refuse.
    if (!Array.isArray(list)) return { live, copy: messageSchema.parse(live), heavy: {} };
    const blockCopies = new Array<ContentBlock>(list.length);
    for (let index = 0; index < list.length; index++) blockCopies[index] = readBlock(list[index]);
    const source: Fields = { ...live, blocks: [] };
    const kept: MessageCopy['heavy'] = {};
    const read: Fields = {};
    for (const field of heavy) {
      const value = (live as Fields)[field];
      read[field] = value;
      const earlier = before?.heavy[field];
      if (value !== undefined && earlier && earlier.from === value) {
        kept[field] = earlier;
        delete source[field];
      }
    }
    const parsed = messageSchema.parse(source) as Fields;
    for (const field of heavy)
      if (!kept[field] && parsed[field] !== undefined)
        kept[field] = { from: read[field], copy: parsed[field] };
    // In the schema's own order, as a whole parse writes it.
    const copy: Fields = {};
    for (const field of messageFields) {
      if (field === 'blocks') copy.blocks = blockCopies;
      else if (field in parsed) copy[field] = parsed[field];
      else if (kept[field]) copy[field] = kept[field].copy;
    }
    return { live, copy: copy as Message, heavy: kept };
  }

  return {
    /** A validated copy of the live conversation, sharing what did not change with the last. */
    read(conversation: Conversation): Conversation {
      const live = (conversation as Fields | null)?.messages;
      if (!Array.isArray(live)) return conversationSchema.parse(conversation);
      let chat = chats.get(conversation.id);
      if (!chat) chats.set(conversation.id, (chat = { messages: new Map(), touched: undefined }));
      const touched = chat.touched;
      chat.touched = new Set();
      try {
        const next = new Map<string, MessageCopy>();
        const messages = new Array<Message>(live.length);
        for (let index = 0; index < live.length; index++) {
          const message = live[index] as Message;
          const before = chat.messages.get((message as Fields | null)?.id as string);
          const current = before?.live === message ? before : undefined;
          const read =
            current && touched && !touched.has(message.id)
              ? current
              : readMessage(message, current);
          next.set(read.copy.id, read);
          messages[index] = read.copy;
        }
        chat.messages = next;
        const head = conversationSchema.parse({ ...conversation, messages: [] });
        const copy: Conversation = { ...head, messages };
        if (options.verify) {
          const whole = conversationSchema.parse(conversation);
          if (!jsonEqual(whole, copy))
            throw new Error(
              `A copy of conversation ${conversation.id} differs from its live data: something edited a message, a block or its file changes in place, or changed a message without saying so (src/lib/chat-snapshots.ts).`,
            );
        }
        return copy;
      } catch (error) {
        // Nothing is known to be current after a copy that failed.
        chat.touched = undefined;
        throw error;
      }
    },
    /** A message changed, or every message of the conversation when none is named. */
    touch(conversationId: string, messageId?: string) {
      const chat = chats.get(conversationId);
      if (!chat) return;
      if (messageId === undefined) chat.touched = undefined;
      else chat.touched?.add(messageId);
    },
    /** Any message of any conversation may have changed. */
    touchAll() {
      for (const chat of chats.values()) chat.touched = undefined;
    },
    /** Lets go of every conversation but these, the ones this device still holds. */
    keep(conversationIds: Iterable<string>) {
      if (!chats.size) return;
      const held = new Set(conversationIds);
      for (const id of chats.keys()) if (!held.has(id)) chats.delete(id);
    },
    /** Another workspace took this one's place. */
    clear() {
      chats.clear();
    },
  };
}
