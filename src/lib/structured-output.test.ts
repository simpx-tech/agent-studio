import { expect, it } from 'vitest';
import { outputSchemaError } from './structured-output';
import {
  chatSettingsSchema,
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Conversation,
} from './domain';
import { forkConversation } from './forks';
import { emptyShared, mergeShared } from './sync';

const schema = JSON.stringify({
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
});
it('bounds schema input and rejects malformed JSON and unsupported roots', () => {
  expect(outputSchemaError(schema)).toBeUndefined();
  for (const value of ['{', 'null', '[]', 'true', '{}', '{"type":"string"}'])
    expect(outputSchemaError(value)).toBeTruthy();
  expect(
    outputSchemaError(JSON.stringify({ type: 'object', description: 'é'.repeat(9000) })),
  ).toContain('bytes');
  let deep: unknown = {};
  for (let i = 0; i < 33; i++) deep = { items: deep };
  expect(outputSchemaError(JSON.stringify({ type: 'object', properties: deep }))).toContain(
    'nested',
  );
  expect(
    chatSettingsSchema.safeParse({
      ...settingsFor(initialWorkspace().preferences),
      outputSchema: '{}',
    }).success,
  ).toBe(false);
});

it('keeps per-reply schema and exact JSON through export, relay, forks and prompt history', () => {
  const w = initialWorkspace();
  const settings = { ...settingsFor(w.preferences), outputSchema: schema };
  const json = JSON.stringify({ answer: '<script>example</script>\n```json' });
  const chat: Conversation = {
    id: crypto.randomUUID(),
    title: 'Structured',
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
        blocks: [{ type: 'markdown', text: json }],
      },
    ],
  };
  w.conversations.push(chat);
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(w)));
  expect(restored.conversations[0]).toEqual(chat);
  expect(historyFor(chat)).toEqual([{ role: 'assistant', text: json }]);
  const base = emptyShared();
  base.conversations.push(structuredClone(chat));
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.conversations[0].settings.outputSchema = undefined;
  const merged = mergeShared(base, local, remote).conversations[0];
  expect(merged.settings.outputSchema).toBeUndefined();
  expect(merged.messages[0].settings?.outputSchema).toBe(schema);
  expect(forkConversation(merged, merged.messages[0].id).settings.outputSchema).toBe(schema);
  expect(forkConversation(merged).settings.outputSchema).toBeUndefined();
  remote.conversations[0].settings.outputSchema = '{"type":"object"}';
  expect(mergeShared(base, local, remote).conversations).toHaveLength(2);
});
