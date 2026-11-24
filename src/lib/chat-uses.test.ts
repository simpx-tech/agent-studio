import { describe, expect, it } from 'vitest';
import { chatUses } from './chat-uses';
import type { ChatSettings, Conversation, Message } from './domain';

const connection = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const settings = (model: string, connectionId = connection): ChatSettings => ({
  provider: 'claude',
  model,
  reasoning: '',
  instructions: '',
  connectionId,
});
let ids = 0;
const message = (role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  role,
  blocks: [],
  status: 'complete',
  createdAt: '2026-11-24T12:00:00.000Z',
  ...extra,
});
const reply = (model: string, modelName?: string, extra: Partial<Message> = {}) =>
  message('assistant', { settings: settings(model), modelName, ...extra });
const chat = (next: ChatSettings, ...messages: Message[]): Conversation => ({
  id: '33333333-3333-4333-8333-333333333333',
  settings: next,
  title: 'A chat',
  createdAt: '2026-11-24T12:00:00.000Z',
  updatedAt: '2026-11-24T12:00:00.000Z',
  messages,
});

describe('what a chat uses', () => {
  it('names the model its latest reply ran when the chat still uses it', () => {
    const c = chat(settings('opus'), message('user'), reply('opus', 'Opus 5.5'));
    expect(chatUses(c)).toEqual({
      provider: 'claude',
      model: 'Opus 5.5',
      connectionId: connection,
    });
    // The CLI default resolves to the model the reply reported.
    const resolved = chat(
      settings(''),
      message('user'),
      reply('', 'CLI default', { usage: { model: 'claude-fable-5-1' } }),
    );
    expect(chatUses(resolved).model).toBe('Fable 5.1');
  });
  it('names a model chosen for the next reply by its id', () => {
    const c = chat(settings('sonnet', other), message('user'), reply('opus', 'Opus 5.5'));
    expect(chatUses(c)).toEqual({ provider: 'claude', model: 'Sonnet', connectionId: other });
    expect(chatUses(chat(settings('claude-haiku-4-5-20251001'), message('user'))).model).toBe(
      'Haiku 4.5',
    );
    expect(chatUses(chat(settings(''), message('user'))).model).toBe('CLI default');
    // Another agent's model is never named after a reply of the earlier one.
    const codex = chat(
      { ...settings('gpt-5.6-sol'), provider: 'codex' },
      reply('gpt-5.6-sol', 'Opus 5.5'),
    );
    expect(chatUses(codex)).toMatchObject({ provider: 'codex', model: 'GPT-5.6-Sol' });
  });
  it('follows a running reply’s model and account over the next reply’s', () => {
    const running = message('assistant', {
      status: 'running',
      settings: settings('opus', other),
      modelName: 'Opus 5.5',
    });
    const c = chat(settings('sonnet'), message('user'), running);
    expect(chatUses(c, running)).toEqual({
      provider: 'claude',
      model: 'Opus 5.5',
      connectionId: other,
    });
    // A reply recorded before replies kept their connection runs on the chat's.
    const { connectionId: _, ...older } = settings('opus');
    const legacy = message('assistant', { status: 'running', settings: older, modelName: 'Opus' });
    expect(chatUses(chat(settings('opus'), legacy), legacy).connectionId).toBe(connection);
  });
  it('keeps the chat’s settings when no reply recorded any', () => {
    const c = chat(settings('fable'), message('user'), message('assistant'));
    expect(chatUses(c)).toEqual({ provider: 'claude', model: 'Fable', connectionId: connection });
  });
});
