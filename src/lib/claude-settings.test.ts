import { expect, it } from 'vitest';
import {
  chatSettingsSchema,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Conversation,
} from './domain';
import { forkConversation } from './forks';
import { emptyShared, mergeShared } from './sync';

it('retains independent thinking budgets through save, relay, reply history and forks', () => {
  const w = initialWorkspace();
  const settings = { ...settingsFor(w.preferences, 'claude'), maxThinkingTokens: 4096 };
  const chat: Conversation = {
    id: crypto.randomUUID(),
    title: 'Settings',
    createdAt: '',
    updatedAt: '',
    settings,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: '',
        settings: { ...settings },
        blocks: [{ type: 'markdown', text: 'Ready' }],
      },
    ],
  };
  w.conversations.push(chat);
  expect(restoreWorkspace(JSON.parse(JSON.stringify(w))).conversations[0]).toEqual(chat);
  const base = emptyShared();
  base.conversations.push(structuredClone(chat));
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.conversations[0].settings.maxThinkingTokens = 0;
  const merged = mergeShared(base, local, remote).conversations[0];
  expect(merged.settings.maxThinkingTokens).toBe(0);
  expect(merged.messages[0].settings?.maxThinkingTokens).toBe(4096);
  expect(forkConversation(merged).settings.maxThinkingTokens).toBe(0);
  expect(forkConversation(merged, merged.messages[0].id).settings.maxThinkingTokens).toBe(4096);
  remote.conversations[0].settings.maxThinkingTokens = undefined;
  expect(mergeShared(base, local, remote).conversations).toHaveLength(2);
});

it('validates default, disabled, and bounded explicit budgets without changing effort', () => {
  const settings = { ...settingsFor(initialWorkspace().preferences, 'claude'), reasoning: 'high' };
  for (const maxThinkingTokens of [undefined, 0, 1024, 4096, 128000]) {
    const parsed = chatSettingsSchema.parse({ ...settings, maxThinkingTokens });
    expect(parsed.maxThinkingTokens).toBe(maxThinkingTokens);
    expect(parsed.reasoning).toBe('high');
  }
  for (const maxThinkingTokens of [-1, 1, 1023, 1.5, 128001, Infinity, NaN, '4096'])
    expect(chatSettingsSchema.safeParse({ ...settings, maxThinkingTokens }).success).toBe(false);
});
