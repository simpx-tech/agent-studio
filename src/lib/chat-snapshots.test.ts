import { describe, expect, it } from 'vitest';
import { applyRunEvent } from './activity';
import { chatList, chatParts, chatSize, joinBytes, jsonWith } from './chat-bytes';
import { createChatSnapshots } from './chat-snapshots';
import { conversationSchema, type Conversation, type Message } from './domain';
import { jsonEqual } from './json-equal';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-13T12:00:00.000Z';

function message(n: number, fields: Partial<Message> = {}): Message {
  return {
    id: uuid(n),
    role: n % 2 ? 'assistant' : 'user',
    blocks: [{ type: 'markdown', text: `Message ${n}` }],
    status: 'complete',
    createdAt: at,
    ...fields,
  };
}
const call = (id: string, revision = 1, status = 'complete') => ({
  id,
  revision,
  category: 'tool',
  name: 'Run command',
  status,
  commandRun: true,
  command: `node build.mjs ${id}`,
});
const block = (id: string) =>
  ({ type: 'activity', text: 'Run command', tool: call(id), order: 0 }) as Message['blocks'][0];

function chat(messages: Message[]): Conversation {
  return {
    id: uuid(900),
    settings: { provider: 'claude', model: '', reasoning: 'medium', instructions: '' },
    title: 'Long chat',
    createdAt: at,
    updatedAt: at,
    messages,
  } as Conversation;
}

const whole = (conversation: Conversation) => conversationSchema.parse(conversation);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const event = (value: object) => value as Parameters<typeof applyRunEvent>[1];

describe('chat snapshots', () => {
  it('copies a conversation as a full parse does', () => {
    const snapshots = createChatSnapshots({ verify: true });
    const live = chat([
      message(0),
      message(1, {
        runId: uuid(50),
        blocks: [block('a'), { type: 'markdown', text: 'Done' }],
        fileChanges: undefined,
        error: undefined,
      }),
    ]);
    const copy = snapshots.read(live);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(whole(live)));
    expect(copy).not.toBe(live);
    expect(copy.messages[1]).not.toBe(live.messages[1]);
  });

  it('shares the messages nobody touched and the blocks that did not change', () => {
    const snapshots = createChatSnapshots({ verify: true });
    const reply = message(1, {
      status: 'running',
      runId: uuid(50),
      blocks: [block('a'), block('b')],
    });
    const live = chat([message(0), reply]);
    const first = snapshots.read(live);
    // Nothing changed: every message is the same copy.
    const again = snapshots.read(live);
    expect(again.messages[0]).toBe(first.messages[0]);
    expect(again.messages[1]).toBe(first.messages[1]);

    applyRunEvent(reply, event({ kind: 'tool', tool: call('b', 2, 'running') }));
    applyRunEvent(reply, event({ kind: 'tool', tool: call('c') }));
    snapshots.touch(live.id, reply.id);
    const next = snapshots.read(live);
    expect(next.messages[0]).toBe(first.messages[0]);
    expect(next.messages[1]).not.toBe(first.messages[1]);
    expect(next.messages[1].blocks[0]).toBe(first.messages[1].blocks[0]);
    expect(next.messages[1].blocks[1]).not.toBe(first.messages[1].blocks[1]);
    expect(next.messages[1].blocks).toHaveLength(3);
    expect(JSON.stringify(next)).toBe(JSON.stringify(whole(live)));
    // The earlier copy still holds what it read.
    expect(first.messages[1].blocks).toHaveLength(2);
  });

  it('reads every message again after a change that names none', () => {
    const snapshots = createChatSnapshots();
    const live = chat([message(0), message(1)]);
    const first = snapshots.read(live);
    live.messages[0].error = 'Edited without naming the message';
    // Not told: the copy before still stands for the message.
    expect(snapshots.read(live).messages[0]).toBe(first.messages[0]);
    snapshots.touch(live.id);
    const next = snapshots.read(live);
    expect(next.messages[0].error).toBe('Edited without naming the message');
    // A message read again without a change keeps its blocks.
    expect(next.messages[1].blocks[0]).toBe(first.messages[1].blocks[0]);
  });

  it('reads a message that took the place of another with its id', () => {
    const snapshots = createChatSnapshots({ verify: true });
    const live = chat([message(0), message(1)]);
    snapshots.read(live);
    live.messages[1] = message(1, { blocks: [{ type: 'markdown', text: 'Rewritten' }] });
    expect(snapshots.read(live).messages[1].blocks).toEqual([
      { type: 'markdown', text: 'Rewritten' },
    ]);
  });

  it('keeps the visuals of a reply that were not replaced', () => {
    const snapshots = createChatSnapshots({ verify: true });
    const reply = message(1, { status: 'running', runId: uuid(50) });
    const live = chat([reply]);
    applyRunEvent(
      reply,
      event({
        kind: 'visualization',
        visualization: { id: 'chart', revision: 1, title: 'Chart', source: '<p>One</p>' },
      }),
    );
    snapshots.touch(live.id, reply.id);
    const first = snapshots.read(live);
    expect(first.messages[0].visualizations).toHaveLength(1);
    applyRunEvent(reply, event({ kind: 'text', text: 'More' }));
    snapshots.touch(live.id, reply.id);
    const next = snapshots.read(live);
    expect(next.messages[0].visualizations).toBe(first.messages[0].visualizations);
    expect(next.messages[0].blocks.at(-1)).toEqual({ type: 'markdown', text: 'More' });
    applyRunEvent(
      reply,
      event({
        kind: 'visualization',
        visualization: { id: 'chart', revision: 2, title: 'Chart', source: '<p>Two</p>' },
      }),
    );
    snapshots.touch(live.id, reply.id);
    const last = snapshots.read(live);
    expect(last.messages[0].visualizations).not.toBe(first.messages[0].visualizations);
    expect(last.messages[0].visualizations?.[0].source).toBe('<p>Two</p>');
  });

  it('refuses what the schema refuses and recovers', () => {
    const snapshots = createChatSnapshots();
    const live = chat([message(0), message(1)]);
    snapshots.read(live);
    (live.messages[1] as Record<string, unknown>).status = 'unheard-of';
    snapshots.touch(live.id, live.messages[1].id);
    expect(() => snapshots.read(live)).toThrow();
    live.messages[1].status = 'complete';
    // Nothing was told since, yet the failed copy leaves nothing trusted.
    expect(snapshots.read(live).messages[1].status).toBe('complete');
    expect(() => snapshots.read({ ...live, messages: undefined } as never)).toThrow();
    expect(() => snapshots.read(chat([{ ...message(0), blocks: undefined } as never]))).toThrow();
  });

  it('follows a reply through a thousand random events', () => {
    const snapshots = createChatSnapshots({ verify: true });
    const reply = message(1, { status: 'running', runId: uuid(50), blocks: [] });
    const live = chat([message(0), reply, message(2), message(3, { blocks: [block('old')] })]);
    let seed = 7;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let calls = 0;
    let answer = '';
    let previous = snapshots.read(live);
    let shared = 0;
    for (let step = 0; step < 1000; step++) {
      const roll = next();
      if (roll < 0.35) {
        calls++;
        applyRunEvent(reply, event({ kind: 'tool', tool: call(`c${calls}`, 1, 'running') }));
      } else if (roll < 0.6 && calls) {
        const id = `c${1 + Math.floor(next() * calls)}`;
        applyRunEvent(
          reply,
          event({ kind: 'tool', tool: { ...call(id, 2 + step), elapsedMs: step * 1000 } }),
        );
      } else if (roll < 0.72) {
        applyRunEvent(
          reply,
          event({
            kind: 'progress',
            id: `p${Math.floor(next() * 12)}`,
            revision: step,
            text: `Comment ${step}`,
          }),
        );
      } else if (roll < 0.82) {
        applyRunEvent(
          reply,
          event({
            kind: 'reasoning',
            id: `r${Math.floor(next() * 6)}`,
            revision: step,
            text: `Thinking ${step}`,
            truncated: false,
          }),
        );
      } else if (roll < 0.94) {
        answer = next() < 0.1 ? '' : `${answer}word${step} `;
        applyRunEvent(reply, event({ kind: 'text', text: answer }));
      } else if (roll < 0.97) {
        applyRunEvent(reply, event({ kind: 'activity', text: `Note ${step}` }));
      } else {
        applyRunEvent(
          reply,
          event({ kind: 'usage', revision: step, input: step, output: 1, contextInput: step }),
        );
      }
      snapshots.touch(live.id, reply.id);
      // Not every event is followed by a copy.
      if (next() < 0.5) continue;
      const copy = snapshots.read(live);
      expect(copy.messages[0]).toBe(previous.messages[0]);
      expect(copy.messages[3]).toBe(previous.messages[3]);
      copy.messages[1].blocks.forEach((b, index) => {
        if (b === previous.messages[1].blocks[index]) shared++;
      });
      previous = copy;
    }
    expect(reply.blocks.length).toBeGreaterThan(300);
    // Most blocks of most copies are the ones the copy before held.
    expect(shared).toBeGreaterThan(50_000);
    expect(jsonEqual(snapshots.read(live), whole(live))).toBe(true);
  });
});

describe('chat bytes', () => {
  it('writes a conversation as JSON that parses to the same data', () => {
    const snapshots = createChatSnapshots();
    const reply = message(1, {
      status: 'running',
      runId: uuid(50),
      blocks: [
        block('a'),
        {
          type: 'markdown',
          text: `Ol${String.fromCodePoint(0xe1)}, "mundo" ${String.fromCodePoint(0x1f600)}`,
        },
      ],
    });
    const live = chat([message(0), reply, message(2, { blocks: [] })]);
    const copy = snapshots.read(live);
    const bytes = joinBytes(chatParts(copy));
    expect(JSON.parse(text(bytes))).toEqual(JSON.parse(JSON.stringify(copy)));
    expect(conversationSchema.parse(JSON.parse(text(bytes)))).toEqual(copy);
    expect(chatSize(copy)).toBe(bytes.length);
    expect(JSON.parse(text(joinBytes(chatList([copy, copy]))))).toHaveLength(2);
    expect(JSON.parse(text(joinBytes(chatList([]))))).toEqual([]);
  });

  it('writes each part once', () => {
    const snapshots = createChatSnapshots();
    const reply = message(1, { status: 'running', runId: uuid(50), blocks: [block('a')] });
    const live = chat([message(0), reply]);
    const first = snapshots.read(live);
    const parts = chatParts(first).filter((part) => typeof part !== 'string');
    applyRunEvent(reply, event({ kind: 'tool', tool: call('b') }));
    snapshots.touch(live.id, reply.id);
    const next = snapshots.read(live);
    const later = chatParts(next).filter((part) => typeof part !== 'string');
    // The message nobody touched is the very same bytes; the reply was put together again.
    expect(later[0]).toBe(parts[0]);
    expect(later[1]).not.toBe(parts[1]);
    expect(JSON.parse(text(joinBytes(chatParts(next))))).toEqual(JSON.parse(JSON.stringify(next)));
  });

  it('puts a body together around parts already written', () => {
    const body = jsonWith({ revision: 3, upsert: 'replaced', remove: ['x'] }, [
      ['upsert', ['[', new TextEncoder().encode('{"id":1}'), ']']],
    ]);
    expect(JSON.parse(text(joinBytes(body)))).toEqual({
      revision: 3,
      remove: ['x'],
      upsert: [{ id: 1 }],
    });
    expect(text(joinBytes(jsonWith({}, [['only', ['null']]])))).toBe('{"only":null}');
    expect(text(joinBytes(jsonWith({ a: undefined }, [['b', ['1']]])))).toBe('{"b":1}');
  });
});
