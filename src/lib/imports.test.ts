import { describe, expect, it } from 'vitest';
import { historyFor, type Workspace } from './domain';
import { emptyFleet } from './fleet';
import {
  byRecency,
  importedChatSchema,
  importedConversation,
  importableChatSchema,
  matchesSearch,
  originName,
  pickerModel,
  type ImportedChat,
} from './imports';
import { replyModelMismatch, replyModelName, replySwitches } from './replies';

const environmentId = crypto.randomUUID();
const computerId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const runId = crypto.randomUUID();
function fleet(): Workspace['fleet'] {
  const fleet = emptyFleet();
  fleet.computers.push({ id: computerId, name: 'Desktop' });
  fleet.environments.push({
    id: environmentId,
    computerId,
    name: 'Windows',
    platform: 'windows',
  });
  const accountId = crypto.randomUUID();
  fleet.accounts.push({ id: accountId, name: 'Work', provider: 'claude', purpose: 'work' });
  fleet.connections.push({ id: connectionId, accountId, environmentId, profile: 'isolated' });
  return fleet;
}
// What the desktop host returns for one Claude session: a prompt, its reply's decoded work, and
// a stopped follow-up.
function claudeChat(): ImportedChat {
  return importedChatSchema.parse({
    title: 'Fix the flaky release build',
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'max',
    location: { computerId, environmentId, path: 'C:\\Projects\\game' },
    connectionId,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:05:00+00:00',
    messages: [
      {
        role: 'user',
        text: 'Why does the release build fail?',
        images: [
          {
            id: crypto.randomUUID(),
            name: 'image-1.png',
            mediaType: 'image/png',
            hash: 'a'.repeat(64),
            bytes: 120,
          },
        ],
        status: 'complete',
        createdAt: '2026-09-01T10:00:00Z',
      },
      {
        role: 'assistant',
        runId,
        status: 'complete',
        createdAt: '2026-09-01T10:00:02Z',
        durationMs: 9000,
        model: 'claude-opus-5-5',
        reasoning: 'max',
        events: [
          {
            kind: 'reasoning',
            id: 'm1:0',
            revision: 1,
            text: 'Checking the build log',
            truncated: false,
          },
          {
            kind: 'tool',
            tool: {
              id: 'claude:t1',
              revision: 2,
              category: 'tool',
              name: 'Run command',
              status: 'complete',
              commandRun: true,
              command: 'npm run build',
              elapsedMs: 5000,
              facts: [],
              sources: [],
              agents: [],
            },
          },
          { kind: 'progress', id: 'm2', revision: 1, text: 'The cache key was stale.' },
          {
            kind: 'progress',
            id: 'm2',
            revision: 4503599627370495,
            text: 'The cache key was stale.',
          },
          { kind: 'text', text: 'The cache key was stale.' },
          {
            kind: 'steering',
            steering: { id: crypto.randomUUID(), text: 'Keep the old cache', runId, sequence: 1 },
          },
          {
            kind: 'usage',
            input: 200,
            output: 10,
            cachedInput: 180,
            contextInput: 100,
            model: 'claude-opus-5-5',
            scope: 'reply',
            revision: 1,
          },
        ],
      },
      {
        role: 'user',
        text: 'Now fix it',
        status: 'complete',
        createdAt: '2026-09-01T10:04:00Z',
      },
      {
        role: 'assistant',
        runId: crypto.randomUUID(),
        status: 'cancelled',
        createdAt: '2026-09-01T10:04:01Z',
        model: 'claude-opus-5-5',
        events: [{ kind: 'progress', id: 'm3', revision: 1, text: 'Looking at the cache.' }],
      },
    ],
    notes: [],
  });
}

describe('imported chats', () => {
  it('builds each reply from its decoded events, as a live reply is, and opens in History', () => {
    const id = crypto.randomUUID();
    const conversation = importedConversation(claudeChat(), id, fleet());
    expect(conversation).toMatchObject({
      id,
      title: 'Fix the flaky release build',
      titleStatus: 'generated',
      archived: true,
      settings: { provider: 'claude', connectionId, model: 'opus', reasoning: 'max' },
      location: { path: 'C:\\Projects\\game' },
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:05:00.000Z',
    });
    const [question, answer, next, stopped] = conversation.messages;
    expect(question.images).toHaveLength(1);
    expect(answer).toMatchObject({
      role: 'assistant',
      runId,
      status: 'complete',
      durationMs: 9000,
      modelName: 'Opus 5.5',
      settings: { model: 'opus', connectionId },
      usage: { input: 200, model: 'claude-opus-5-5' },
    });
    expect(answer.blocks.map((b) => b.type)).toEqual([
      'reasoning',
      'activity',
      'activity',
      'markdown',
    ]);
    expect(answer.steering?.[0].text).toBe('Keep the old cache');
    expect(next.role).toBe('user');
    expect(stopped.status).toBe('cancelled');
    // The model that ran reads as its version, with no mismatch against the picker's alias.
    expect(replyModelName(answer)).toBe('Opus 5.5');
    expect(replyModelMismatch(answer)).toBeUndefined();
    expect(replySwitches(conversation.messages).size).toBe(0);
    // A stopped reply never becomes assistant history; the steering does.
    expect(historyFor(conversation)).toEqual([
      expect.objectContaining({ role: 'user', text: 'Why does the release build fail?' }),
      expect.objectContaining({ role: 'assistant' }),
      { role: 'user', text: 'Now fix it' },
    ]);
    expect(historyFor(conversation)[1].text).toContain('The cache key was stale.');
    expect(historyFor(conversation)[1].text).toContain('Keep the old cache');
  });

  it('keeps titles short, Codex model ids as reported, and haiku without reasoning', () => {
    const chat = claudeChat();
    chat.title = `  ${'Long title '.repeat(20)}`;
    const conversation = importedConversation(chat, crypto.randomUUID(), fleet());
    expect(conversation.title.length).toBeLessThanOrEqual(100);
    expect(conversation.title.endsWith('…')).toBe(true);
    expect(pickerModel('codex', 'gpt-6-astra')).toBe('gpt-6-astra');
    expect(pickerModel('claude', 'claude-sonnet-5-20260101')).toBe('sonnet');
    expect(pickerModel('claude', 'my-custom-model')).toBe('my-custom-model');
    chat.model = 'claude-haiku-4-5-20251001';
    expect(importedConversation(chat, crypto.randomUUID(), fleet()).settings).toMatchObject({
      model: 'haiku',
      reasoning: '',
    });
  });

  it('refuses host results the workspace cannot keep', () => {
    const chat = claudeChat();
    chat.location = { computerId, environmentId, path: 'x'.repeat(5000) };
    expect(() => importedConversation(chat, crypto.randomUUID(), fleet())).toThrow();
    expect(() => importedChatSchema.parse({ ...claudeChat(), provider: 'gemini' })).toThrow();
  });

  it('lists chats by recency and finds them by title, first prompt or folder', () => {
    const listed = (title: string, updatedAt: string, path = 'C:\\work\\app') =>
      importableChatSchema.parse({
        key: crypto.randomUUID().replaceAll('-', ''),
        session: crypto.randomUUID().replaceAll('-', ''),
        title,
        preview: 'Make the menu faster',
        path,
        updatedAt,
        origin: 'desktop',
      });
    const older = listed('Older', '2026-09-01T10:00:00Z');
    const newer = listed('Newer', '2026-09-02T10:00:00+00:00', 'C:\\games\\voxel');
    expect([older, newer].sort(byRecency).map((c) => c.title)).toEqual(['Newer', 'Older']);
    expect(matchesSearch(newer, 'voxel menu')).toBe(true);
    expect(matchesSearch(older, 'voxel')).toBe(false);
    expect(matchesSearch(older, '  ')).toBe(true);
    expect(originName('claude', 'desktop')).toBe('Claude app');
    expect(originName('codex', 'exec')).toBe('codex exec');
  });
});
