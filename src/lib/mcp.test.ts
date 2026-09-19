import { expect, it } from 'vitest';
import { mcpActionSchema, mcpRequestSchema } from './mcp';

it('accepts bounded management and callback requests without arbitrary protocol fields', () => {
  const base = {
    provider: 'claude',
    connectionId: crypto.randomUUID(),
    conversationId: null,
    location: null,
  };
  expect(
    mcpRequestSchema.safeParse({ ...base, action: { kind: 'authenticate', name: 'docs' } }).success,
  ).toBe(true);
  expect(
    mcpRequestSchema.safeParse({ ...base, threadId: 'foreign', action: { kind: 'reload' } })
      .success,
  ).toBe(false);
  expect(mcpActionSchema.safeParse({ kind: 'authenticate', name: '--help' }).success).toBe(false);
  expect(
    mcpActionSchema.safeParse({
      kind: 'callback',
      operationId: crypto.randomUUID(),
      callbackUrl: 'http://localhost:8123/callback?code=synthetic',
    }).success,
  ).toBe(true);
});
it('rejects credential-bearing, executable and oversized server definitions', () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/config',
    'http://remote.example/mcp',
    'https://user:secret@example.com',
  ]) {
    expect(
      mcpActionSchema.safeParse({ kind: 'add', name: 'docs', server: { type: 'http', url } })
        .success,
    ).toBe(false);
  }
  expect(
    mcpActionSchema.safeParse({
      kind: 'add',
      name: 'docs',
      server: { type: 'http', url: 'https://example.com', headers: { Authorization: 'secret' } },
    }).success,
  ).toBe(false);
  expect(
    mcpActionSchema.safeParse({
      kind: 'setServers',
      servers: { agent_studio: { type: 'stdio', command: 'evil', args: [] } },
    }).success,
  ).toBe(false);
  expect(
    mcpActionSchema.safeParse({
      kind: 'add',
      name: 'docs',
      server: { type: 'stdio', command: 'node', args: ['literal $(no-shell)', 'with spaces'] },
    }).success,
  ).toBe(true);
});
