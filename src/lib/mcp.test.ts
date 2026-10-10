import { expect, it } from 'vitest';
import { mcpActionSchema, mcpRequestSchema } from './mcp';

it('accepts management and callback requests of any length without arbitrary protocol fields', () => {
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
  expect(
    mcpActionSchema.safeParse({
      kind: 'callback',
      operationId: crypto.randomUUID(),
      callbackUrl: `http://localhost:8123/callback?code=${'c'.repeat(10_000)}`,
    }).success,
  ).toBe(true);
});
it('rejects credential-bearing and executable server definitions, never their number or size', () => {
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
  // Any number of servers and arguments, of any length.
  const servers = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `server-${i}`,
      {
        type: 'stdio',
        command: `/tools/${'x'.repeat(5000)}`,
        args: Array(70).fill('a'.repeat(100)),
      },
    ]),
  );
  expect(mcpActionSchema.safeParse({ kind: 'setServers', servers }).success).toBe(true);
});
