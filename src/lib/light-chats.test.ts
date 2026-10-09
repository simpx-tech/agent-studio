import { expect, it } from 'vitest';
import type { Conversation, Message } from './domain';
import { sharedChatSchema } from './sync';
import {
  isLightMessage,
  lightChat,
  lightMessage,
  messagesById,
  restoreChat,
  restoreMessage,
} from './light-chats';

const user = (id: string, text: string): Message => ({
  id,
  role: 'user',
  status: 'complete',
  createdAt: '2026-10-09T12:00:00.000Z',
  blocks: [{ type: 'markdown', text }],
});
const tool = (id: string, command: string) => ({
  type: 'activity' as const,
  text: `Ran ${command}`,
  tool: {
    id,
    revision: 2,
    category: 'tool' as const,
    name: 'Bash',
    status: 'complete' as const,
    command,
    facts: [],
    sources: [],
    agents: [],
  },
});
const reply = (id: string, answer: string): Message => ({
  id,
  role: 'assistant',
  status: 'complete',
  createdAt: '2026-10-09T12:00:01.000Z',
  runId: '9f0e3c8c-6a4f-4d6c-8a43-5d9c3a0f2b11',
  blocks: [
    {
      type: 'reasoning',
      id: 'r1',
      revision: 1,
      text: 'Checking the tests first.',
      truncated: false,
    },
    tool('call-1', 'npm test'),
    { type: 'activity', text: 'The tests pass.', progress: { id: 'p1', revision: 0 } },
    tool('call-2', 'npm run build'),
    { type: 'markdown', text: answer },
  ],
  fileChanges: {
    revision: 3,
    limited: false,
    edits: [{ id: 'edit-1', files: [{ path: 'src/app.ts', kind: 'modified', hunks: [] }] }],
  },
});
const chat = (messages: Message[], removed?: Message[]): Conversation => ({
  id: '0b4c0d3e-1e1f-4a54-9a7e-5f1f4b0b8b61',
  title: 'Fix the build',
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:02.000Z',
  settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
  messages,
  ...(removed ? { rewind: { removed, createdAt: '2026-10-09T12:00:03.000Z' } } : {}),
});
const ids = {
  user: '3a1f3a5c-0f53-4f39-9c7e-6c0a2f6a8e01',
  reply: '3a1f3a5c-0f53-4f39-9c7e-6c0a2f6a8e02',
  later: '3a1f3a5c-0f53-4f39-9c7e-6c0a2f6a8e03',
};

it('keeps a message’s text and settings and leaves out its recorded work', () => {
  const full = reply(ids.reply, 'Fixed it.');
  const light = lightMessage(full);
  expect(isLightMessage(full)).toBe(false);
  expect(isLightMessage(light)).toBe(true);
  expect(light.blocks).toEqual([{ type: 'markdown', text: 'Fixed it.' }]);
  expect(light).not.toHaveProperty('fileChanges');
  expect({ ...light, blocks: undefined }).toEqual({
    ...full,
    blocks: undefined,
    fileChanges: undefined,
  });
  // Messages without recorded work are returned as they are.
  const plain = user(ids.user, 'Fix the build');
  expect(lightMessage(plain)).toBe(plain);
});

it('makes every message of a chat light, those a rewind removed included, unless kept', () => {
  const conversation = chat(
    [user(ids.user, 'Fix the build'), reply(ids.reply, 'Fixed it.')],
    [reply(ids.later, 'Then this.')],
  );
  const light = lightChat(conversation);
  expect(light.messages.every(isLightMessage)).toBe(true);
  expect(light.rewind!.removed.every(isLightMessage)).toBe(true);
  // The light chat is still a valid saved conversation.
  expect(sharedChatSchema.parse(light)).toEqual(light);
  // A message named to keep, such as a fork's, keeps its work.
  const kept = lightChat(conversation, (m) => m.id === ids.later);
  expect(kept.rewind!.removed[0]).toBe(conversation.rewind!.removed[0]);
  expect(isLightMessage(kept.messages[1])).toBe(true);
  // Nothing heavy: the same object.
  expect(lightChat(light)).toBe(light);
});

it('puts a reply’s recorded work back in its recorded order when the text matches', () => {
  const full = reply(ids.reply, 'Fixed it.');
  const restored = restoreMessage({ ...lightMessage(full), filesUndone: true }, full);
  expect(restored.blocks).toBe(full.blocks);
  expect(restored.fileChanges).toBe(full.fileChanges);
  // Fields of the light copy win: they are its edits.
  expect(restored.filesUndone).toBe(true);
});

it('adds the recorded work to newer text without dropping either', () => {
  const full = reply(ids.reply, 'Fixed');
  const newer = {
    ...lightMessage(full),
    blocks: [{ type: 'markdown' as const, text: 'Fixed it.' }],
  };
  const restored = restoreMessage(newer, full);
  expect(restored.blocks.filter((b) => b.type === 'markdown')).toEqual([
    { type: 'markdown', text: 'Fixed it.' },
  ]);
  expect(restored.blocks.filter((b) => b.type !== 'markdown')).toHaveLength(4);
  expect(restored.fileChanges).toBe(full.fileChanges);
});

it('never replaces work a message holds, and restores file changes alone when missing', () => {
  const full = reply(ids.reply, 'Fixed it.');
  const other = reply(ids.reply, 'Fixed it.');
  other.blocks = [tool('call-9', 'git status'), { type: 'markdown', text: 'Fixed it.' }];
  // A message with its own calls keeps them.
  expect(restoreMessage(other, full).blocks).toBe(other.blocks);
  // Its missing file changes still come back.
  const { fileChanges, ...withoutChanges } = other;
  expect(fileChanges).toBeDefined();
  expect(restoreMessage(withoutChanges, full).fileChanges).toBe(full.fileChanges);
  // Another message, or no copy, restores nothing.
  const light = lightMessage(full);
  expect(restoreMessage(light, reply(ids.later, 'Fixed it.'))).toBe(light);
  expect(restoreMessage(light, undefined)).toBe(light);
});

it('restores a whole chat from the copies it names, rewound messages included', () => {
  const conversation = chat(
    [user(ids.user, 'Fix the build'), reply(ids.reply, 'Fixed it.')],
    [reply(ids.later, 'Then this.')],
  );
  const light = lightChat(conversation);
  const found = messagesById([conversation]);
  expect(restoreChat(light, (id) => found.get(id))).toEqual(conversation);
  // Nothing to restore: the same object.
  expect(restoreChat(conversation, (id) => found.get(id))).toBe(conversation);
  expect(restoreChat(light, () => undefined)).toBe(light);
});
