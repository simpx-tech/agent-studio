// Real Claude control protocol, isolated profile, no model request or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'studio-mcp-controls-'));
const fixture = join(root, 'server.mjs');
await writeFile(
  fixture,
  `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.id===undefined)return;let result={};if(v.method==='initialize')result={protocolVersion:v.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(v.method==='tools/list')result={tools:[]};console.log(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));});`,
);
const child = spawn(
  'claude',
  [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--settings',
    '{"disableAllHooks":true}',
    '--mcp-config',
    '{"mcpServers":{"agent_studio":{"type":"sdk","name":"agent_studio"}}}',
  ],
  {
    cwd: root,
    env: { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDECODE: '' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  },
);
let next = 0;
const pending = new Map();
const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'control_request' && value.request.subtype === 'mcp_message') {
    const message = value.request.message;
    let result = {};
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent_studio', version: '1' },
      };
    if (message.method === 'tools/list') result = { tools: [] };
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: value.request_id,
        response: { mcp_response: { jsonrpc: '2.0', id: message.id, result } },
      },
    });
  }
  if (value.type === 'control_response') {
    const waiter = pending.get(value.response.request_id);
    if (waiter) {
      clearTimeout(waiter.timeout);
      pending.delete(value.response.request_id);
      value.response.subtype === 'success'
        ? waiter.resolve(value.response.response ?? {})
        : waiter.reject(Error('CLI rejected control'));
    }
  }
});
const request = (subtype, params = {}) =>
  new Promise((resolve, reject) => {
    const request_id = String(++next);
    const timeout = setTimeout(() => reject(Error(`${subtype} timed out`)), 30000);
    pending.set(request_id, { resolve, reject, timeout });
    write({ type: 'control_request', request_id, request: { subtype, ...params } });
  });
try {
  await request('initialize');
  const servers = {
    agent_studio: { type: 'sdk', name: 'agent_studio' },
    qa_stdio: { type: 'stdio', command: process.execPath, args: [fixture] },
  };
  const applied = await request('mcp_set_servers', { servers });
  assert.deepEqual(applied.errors, {});
  await request('mcp_reconnect', { serverName: 'qa_stdio' });
  assert(
    (await request('mcp_status')).mcpServers.some(
      (s) => s.name === 'qa_stdio' && s.status === 'connected',
    ),
  );
  await request('mcp_toggle', { serverName: 'qa_stdio', enabled: false });
  assert(
    (await request('mcp_status')).mcpServers.some(
      (s) => s.name === 'qa_stdio' && s.status === 'disabled',
    ),
  );
  await request('mcp_toggle', { serverName: 'qa_stdio', enabled: true });
  const status = await request('mcp_status');
  assert(status.mcpServers.some((s) => s.name === 'qa_stdio' && s.status === 'connected'));
  assert(status.mcpServers.some((s) => s.name === 'agent_studio' && s.status === 'connected'));
  await mkdir('artifacts/mcp-management', { recursive: true });
  const result = {
    setServers: true,
    reconnect: true,
    toggle: true,
    studioPreserved: true,
    modelRequests: 0,
  };
  await writeFile('artifacts/mcp-management/live-controls-result.json', JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  lines.close();
  child.stdin.end();
  for (const { timeout } of pending.values()) clearTimeout(timeout);
  // Terminate only this test-owned process tree.
  if (process.platform === 'win32')
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else child.kill();
}
