import { expect, it } from 'vitest';
import { createFinishedChatTracker, type FinishedChats } from './finished-chats';
import type { Conversation, Message } from './domain';

const time = Date.now();
function chat(status: Message['status'] = 'running', createdAt = time): Conversation {
  return {
    id: crypto.randomUUID(),
    messages: [
      { id: crypto.randomUUID(), role: 'user', status: 'complete', createdAt: '', blocks: [] },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        runId: crypto.randomUUID(),
        status,
        createdAt: new Date(createdAt).toISOString(),
        blocks: [],
      },
    ],
  } as unknown as Conversation;
}
const reply = (c: Conversation) => c.messages[1];

it('marks nothing for restored history, archival changes or replies older than this session', () => {
  const observe = createFinishedChatTracker(() => time);
  const old = chat('complete', time - 1000);
  expect(observe([old], {})).toEqual({});
  old.archived = true;
  const imported = chat('complete', time - 86_400_000);
  expect(observe([old, imported], {})).toEqual({});
});

it('marks each finished chat once, keeps the open one clear, and clears it when opened', () => {
  const observe = createFinishedChatTracker(() => time);
  const [first, second, third] = [chat(), chat(), chat()];
  const chats = [first, second, third];
  expect(observe(chats, {})).toEqual({});
  for (const [index, status] of (['complete', 'error', 'cancelled'] as const).entries())
    reply(chats[index]).status = status;
  // The chat on screen is read where it stands; the others are marked by their finished run.
  let marks = observe(chats, {}, third.id);
  expect(marks).toEqual({
    [first.id]: reply(first).runId,
    [second.id]: reply(second).runId,
  });
  // Repeated updates neither mark the open chat later nor replace the record.
  expect(observe(chats, marks, third.id)).toBe(marks);
  expect(observe(chats, marks)).toBe(marks);

  delete marks[first.id];
  expect(observe(chats, marks)).toEqual({ [second.id]: reply(second).runId });
});

it(`replaces a mark with the chat's later reply and drops it once the run is gone`, () => {
  const observe = createFinishedChatTracker(() => time);
  const conversation = chat();
  expect(observe([conversation], {})).toEqual({});
  reply(conversation).status = 'complete';
  const first = observe([conversation], {});
  expect(first).toEqual({ [conversation.id]: reply(conversation).runId });

  // A reply running again in that chat shows its spinner instead of a stale dot.
  const next = { ...reply(conversation), id: crypto.randomUUID(), runId: crypto.randomUUID() };
  conversation.messages.push(next as Message);
  next.status = 'running';
  expect(observe([conversation], first)).toEqual({});
  next.status = 'complete';
  const second = observe([conversation], {});
  expect(second).toEqual({ [conversation.id]: next.runId });

  // A rewind that removes the reply, and a deleted chat, take the mark with them.
  conversation.messages.pop();
  expect(observe([conversation], second)).toEqual({});
  expect(observe([], second)).toEqual({});
});

it('marks a reply that started and finished between two updates, but not an old import', () => {
  let clock = time;
  const observe = createFinishedChatTracker(() => clock);
  expect(observe([], {})).toEqual({});
  clock = time + 1000;
  const quick = chat('complete', time + 500);
  const stale = chat('complete', time - 600_000);
  expect(observe([quick, stale], {})).toEqual({ [quick.id]: reply(quick).runId });
});

it('keeps marks bounded to the chats it is given', () => {
  const observe = createFinishedChatTracker(() => time);
  const marks: FinishedChats = { [crypto.randomUUID()]: crypto.randomUUID() };
  expect(observe([], marks)).toEqual({});
  expect(marks).not.toEqual({});
});
