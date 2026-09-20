// Deterministic subprocess fixture for the production stream runners. No login,
// network, files, or model calls. A wrong native response fails the process.
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const provider = process.argv[2],
  action = process.argv[3],
  mode = process.argv[4];
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
function ask() {
  if (provider === 'claude')
    emit({
      type: 'control_request',
      request_id: 'elicit',
      request: {
        subtype: 'elicitation',
        mcp_server_name: 'fixture',
        message: 'Fixture request',
        mode,
        requested_schema: schema,
        url: 'https://example.com/continue',
        elicitation_id: 'url-1',
      },
    });
  else
    emit({
      id: 71,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'root',
        turnId: 'turn',
        serverName: 'fixture',
        message: 'Fixture request',
        mode,
        requestedSchema: schema,
        url: 'https://example.com/continue',
        elicitationId: 'url-1',
      },
    });
}
function finish(interrupted = false) {
  if (provider === 'claude') {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ELICITATION ROUNDTRIP PASSED' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: 'ELICITATION ROUNDTRIP PASSED',
      is_error: false,
    });
    process.exit(0);
  } else {
    emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'root',
        turnId: 'turn',
        itemId: 'reply',
        delta: 'ELICITATION ROUNDTRIP PASSED',
      },
    });
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'root',
        turn: { id: 'turn', status: interrupted ? 'interrupted' : 'completed' },
      },
    });
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const v = JSON.parse(line);
  if (provider === 'claude') {
    if (v.request?.subtype === 'initialize')
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: v.request_id, response: {} },
      });
    else if (v.type === 'user') ask();
    else if (v.type === 'control_response') {
      assert.equal(v.response.subtype, 'success');
      assert.equal(v.response.request_id, 'elicit');
      assert.equal(v.response.response.action, action);
      assert.deepEqual(
        v.response.response.content,
        action === 'accept' && mode === 'form' ? { name: 'Ada' } : undefined,
      );
      finish();
    }
  } else {
    if (v.method === 'initialize') emit({ id: v.id, result: {} });
    else if (v.method === 'thread/start')
      emit({ id: v.id, result: { thread: { id: 'root' }, model: 'fixture' } });
    else if (v.method === 'turn/start') {
      emit({ id: v.id, result: { turn: { id: 'turn' } } });
      ask();
    } else if (v.id === 71 && !v.method) {
      assert.equal(v.result.action, action);
      assert.deepEqual(
        v.result.content,
        action === 'accept' && mode === 'form' ? { name: 'Ada' } : null,
      );
      emit({ method: 'serverRequest/resolved', params: { threadId: 'root', requestId: 71 } });
      finish();
    } else if (v.method === 'account/usage/read')
      emit({ id: v.id, error: { code: -32601, message: 'Not supported' } });
    else if (v.method === 'turn/interrupt') {
      emit({ id: v.id, result: {} });
      finish(true);
    }
  }
}
