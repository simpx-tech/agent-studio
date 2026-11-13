import { describe, expect, it, vi } from 'vitest';
import { conversationSchema, type Conversation } from './domain';
import {
  aheadArguments,
  chatChunks,
  readBatches,
  readChats,
  sendAhead,
  type ChatChunk,
} from './saved-parts';
import { joinBytes } from './chat-bytes';

const chat = (id: string, text = ''): Conversation =>
  conversationSchema.parse({
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    title: `Chat ${id} é 😀`,
    createdAt: '2026-11-13',
    updatedAt: '2026-11-13',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: text
      ? ['user' as const, 'assistant' as const].map((role, index) => ({
          id: `00000000-0000-4000-9000-${`${id}${index}`.padStart(12, '0')}`,
          role,
          blocks: [{ type: 'markdown' as const, text: `${text} “${role}”` }],
          status: 'complete' as const,
          createdAt: '2026-11-13',
        }))
      : [],
  });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const listed = (chunk: ChatChunk) => JSON.parse(new TextDecoder().decode(joinBytes(chunk.list)));

describe('reading a saved file in parts', () => {
  it('asks for about a budget of conversations at a time, in the file’s order', () => {
    const chats: [string, number][] = [
      ['a', 40],
      ['b', 40],
      ['c', 40],
      // Larger than a whole read: it goes alone, and nothing is left out.
      ['d', 500],
      ['e', 10],
      ['f', 90],
    ];
    expect(readBatches(chats, 100)).toEqual([['a', 'b'], ['c'], ['d'], ['e', 'f']]);
    expect(readBatches([], 100)).toEqual([]);
    expect(readBatches(chats, Infinity)).toEqual([['a', 'b', 'c', 'd', 'e', 'f']]);
  });

  it('hands each list over as it arrives, from bytes however the app sends them', async () => {
    const held = new Map(
      [chat('1', 'one'), chat('2', 'two'), chat('3', 'three')].map((c) => [c.id, c]),
    );
    const chats = [...held].map(([id, c]) => [id, bytes(c).length] as [string, number]);
    const asked: string[][] = [];
    const taken: unknown[][] = [];
    let calls = 0;
    const done = await readChats(
      chats,
      async (ids) => {
        asked.push(ids);
        const list = bytes(ids.map((id) => held.get(id)));
        // An ArrayBuffer, a view of one, and the array of numbers `postMessage` makes of them.
        return [list.buffer, list, Array.from(list)][calls++ % 3];
      },
      (list) => void taken.push(list),
      1,
    );
    expect(done).toBe(true);
    expect(asked).toEqual([...held.keys()].map((id) => [id]));
    expect(taken.flat()).toEqual([...held.values()]);
  });

  it('stops where it is told to, and refuses an answer that is not the list asked for', async () => {
    const chats: [string, number][] = [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ];
    const read = vi.fn(async (ids: string[]) => bytes(ids.map((id) => ({ id }))));
    expect(await readChats(chats, read, () => read.mock.calls.length < 2, 1)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(
      readChats(
        chats,
        async () => bytes([]),
        () => {},
        1,
      ),
    ).rejects.toThrow('without the conversations');
    await expect(
      readChats(
        chats,
        async () => bytes({ a: 1 }),
        () => {},
        1,
      ),
    ).rejects.toThrow('without the conversations');
    // A read the app refuses ends the reading with its reason.
    await expect(
      readChats(
        chats,
        () => Promise.reject('The saved file changed while it was read.'),
        () => {},
      ),
    ).rejects.toBe('The saved file changed while it was read.');
  });
});

describe('sending conversations in parts', () => {
  const chats = [
    chat('1', 'x'.repeat(300)),
    chat('2', 'y'.repeat(300)),
    chat('3'),
    chat('4', 'z'.repeat(2000)),
  ];

  it('writes each list as the JSON of its conversations, either way of writing them', () => {
    // Room for the second and third together, which the first and second exceed.
    const budget = bytes(chats[1]).length + bytes(chats[2]).length;
    for (const keep of [false, true]) {
      const chunks = [...chatChunks(chats, { keep, budget })];
      expect(chunks.map((chunk) => chunk.chats.map((c) => c.id))).toEqual([
        [chats[0].id],
        [chats[1].id, chats[2].id],
        // Larger than the budget: alone, and whole.
        [chats[3].id],
      ]);
      for (const chunk of chunks) expect(listed(chunk)).toEqual(chunk.chats);
      expect(chunks.flatMap(listed)).toEqual(chats);
    }
    expect([...chatChunks([])]).toEqual([]);
    expect([...chatChunks(chats)].map(listed)).toEqual([chats]);
  });

  it('makes each list as it is asked for, so one is held at a time', () => {
    const made: string[] = [];
    const source = (function* () {
      for (const c of chats) {
        made.push(c.id);
        yield c;
      }
    })();
    const chunks = chatChunks(source, { budget: 1 });
    expect(made).toEqual([]);
    chunks.next();
    // The first list ends once the second conversation is seen not to fit.
    expect(made).toEqual([chats[0].id, chats[1].id]);
  });

  it('sends nothing ahead when one call carries everything', async () => {
    const ahead = vi.fn(async () => {});
    expect(await sendAhead([], ahead)).toEqual({ ahead: false, only: undefined });
    const [only] = [...chatChunks(chats)];
    expect(await sendAhead([only], ahead)).toEqual({ ahead: false, only });
    expect(ahead).not.toHaveBeenCalled();
  });

  it('sends every list ahead, in order, when there are several', async () => {
    const sent: string[][] = [];
    const ahead = async (chunk: ChatChunk) => void sent.push(chunk.chats.map((c) => c.id));
    expect(await sendAhead(chatChunks(chats, { budget: 1 }), ahead)).toEqual({ ahead: true });
    expect(sent).toEqual(chats.map((c) => [c.id]));
    // A list the app refuses ends the save there.
    await expect(
      sendAhead(chatChunks(chats, { budget: 1 }), () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused');
  });

  it('names the save each list goes ahead of, as bytes or as plain arguments', () => {
    const [chunk] = [...chatChunks(chats.slice(0, 2))];
    const plain = aheadArguments('save-1', chunk, true);
    expect(plain).toEqual({ save: 'save-1', upsert: chunk.chats });
    const sent = aheadArguments('save-1', chunk, false);
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(sent as Uint8Array))).toEqual(plain);
  });
});
