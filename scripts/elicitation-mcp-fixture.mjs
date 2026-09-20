// Disposable MCP stdio server for opt-in tests with installed provider CLIs.
// Only asks for synthetic data; never reads files, credentials, or the network.
import { createInterface } from 'node:readline';
const pending = new Map();
let next = 1000;
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const v = JSON.parse(line);
  if (v.method === 'initialize')
    send({
      id: v.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'elicitation-fixture', version: '1.0.0' },
      },
    });
  else if (v.method === 'tools/list')
    send({
      id: v.id,
      result: {
        tools: [
          {
            name: 'prompt',
            description:
              'Ask the user for synthetic form or URL input, then report the chosen action.',
            inputSchema: {
              type: 'object',
              properties: { mode: { type: 'string', enum: ['form', 'url'] } },
              required: ['mode'],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  else if (v.method === 'tools/call') {
    const mode = v.params.arguments.mode,
      id = next++;
    pending.set(id, v.id);
    send({
      id,
      method: 'elicitation/create',
      params:
        mode === 'url'
          ? {
              mode,
              message: 'Open the synthetic test page or decline this request.',
              url: 'https://example.com/elicitation-fixture',
              elicitationId: 'fixture-url',
            }
          : {
              mode: 'form',
              message: 'Enter the synthetic test name Ada.',
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string', title: 'Test name', minLength: 2 } },
                required: ['name'],
              },
            },
    });
  } else if (pending.has(v.id)) {
    const id = pending.get(v.id);
    pending.delete(v.id);
    const action = v.result?.action;
    send({
      id,
      result: {
        content: [
          {
            type: 'text',
            text: action
              ? `ELICITATION_FIXTURE_${action.toUpperCase()}`
              : `ELICITATION_FIXTURE_ERROR: ${v.error?.message ?? 'missing action'}`,
          },
        ],
        isError: !action,
      },
    });
  } else if (v.method === 'ping') send({ id: v.id, result: {} });
}
