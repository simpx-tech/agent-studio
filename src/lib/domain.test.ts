import { describe, expect, it } from 'vitest';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  chatSettingsSchema,
  rememberSettings,
  settingsFor,
  type Conversation,
} from './domain';

describe('portable conversation state', () => {
  it('restores interrupted runs without inventing completed responses', () => {
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      title: 'Test',
      titleStatus: 'pending',
      createdAt: '2026-09-08',
      updatedAt: '2026-09-08',
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          blocks: [{ type: 'markdown', text: 'Partial' }],
          status: 'running',
          createdAt: '2026-09-08',
        },
      ],
    });
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[0].messages[0].status).toBe('cancelled');
    expect(restored.conversations[0].messages[0].blocks[0].text).toBe('Partial');
    expect(restored.conversations[0].titleStatus).toBe('fallback');
    expect(restored.conversations[0].title).toBe('Test');
  });
  it('only passes user messages and completed assistant messages to a provider', () => {
    const c: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(initialWorkspace().preferences),
      title: 'Test',
      createdAt: '',
      updatedAt: '',
      messages: [],
    };
    c.messages = [
      {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'markdown', text: 'Hello' }],
        status: 'complete',
        createdAt: '',
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [
          { type: 'activity', text: 'Metadata' },
          { type: 'markdown', text: 'Hi' },
        ],
        status: 'complete',
        createdAt: '',
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'markdown', text: 'Broken' }],
        status: 'error',
        createdAt: '',
      },
    ];
    expect(historyFor(c)).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi' },
    ]);
  });
  it('rejects corrupted data and future schemas rather than erasing saved history', () => {
    expect(() => restoreWorkspace({ version: 999 })).toThrow();
    expect(() => restoreWorkspace({ ...initialWorkspace(), preferences: null })).toThrow();
    expect(
      chatSettingsSchema.safeParse({
        ...settingsFor(initialWorkspace().preferences),
        provider: 'shell',
      }).success,
    ).toBe(false);
  });
  it('remembers the model per provider and reasoning per provider/model without changing chats', () => {
    const workspace = initialWorkspace();
    const settings = settingsFor(workspace.preferences);
    rememberSettings(workspace.preferences, { ...settings, model: 'model-a', reasoning: 'high' });
    rememberSettings(workspace.preferences, { ...settings, model: 'model-b', reasoning: 'low' });
    rememberSettings(workspace.preferences, {
      ...settings,
      provider: 'claude',
      model: 'model-a',
      reasoning: 'max',
    });
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(settingsFor(restored.preferences, 'codex')).toMatchObject({
      model: 'model-b',
      reasoning: 'low',
    });
    expect(settingsFor(restored.preferences)).toMatchObject({
      provider: 'claude',
      model: 'model-a',
      reasoning: 'max',
    });
    expect(restored.preferences.reasoningByProvider.codex?.['model-a']).toBe('high');
    expect(settings.model).toBe('');
    expect(settings.reasoning).toBe('');
  });
  it('migrates saved agents and conversations without losing instructions, messages, or attribution', () => {
    const agent = {
      id: crypto.randomUUID(),
      name: 'Writing partner',
      provider: 'gemini',
      model: 'gemini-3.8-flash-high',
      instructions: 'Use short sentences.',
      description: 'Custom role',
    };
    const old = {
      version: 1,
      agents: [agent],
      conversations: [
        {
          id: crypto.randomUUID(),
          agent,
          title: 'Existing chat',
          createdAt: '2026-09-08',
          updatedAt: '2026-09-08',
          messages: [
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              blocks: [{ type: 'markdown', text: 'Existing answer' }],
              status: 'complete',
              createdAt: '2026-09-08',
            },
          ],
        },
      ],
    };
    const original = JSON.stringify(old);
    const migrated = restoreWorkspace(old);
    expect(migrated.version).toBe(3);
    expect(migrated.legacyAgents).toEqual([agent]);
    expect(migrated.conversations[0].id).toBe(old.conversations[0].id);
    expect(migrated.conversations[0].settings).toEqual({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      reasoning: 'high',
      instructions: 'Use short sentences.',
    });
    expect(migrated.conversations[0].messages[0]).toMatchObject({
      authorName: 'Writing partner',
      blocks: old.conversations[0].messages[0].blocks,
      settings: migrated.conversations[0].settings,
    });
    expect(settingsFor(migrated.preferences)).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      reasoning: 'high',
      instructions: '',
    });
    expect(JSON.stringify(old)).toBe(original);
    expect(restoreWorkspace(migrated)).toEqual(migrated);
  });
});
