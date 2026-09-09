import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const previous = JSON.parse(await readFile('artifacts/capabilities-provider-probe.json', 'utf8'));
const folder = previous.providers.codex.folder;
const env = { ...process.env };
delete env.CODEX_THREAD_ID;
delete env.CLAUDECODE;
const child = spawn(
  join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe'),
  ['app-server', '--stdio'],
  { cwd: folder, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
let next = 1,
  root,
  buffer = '',
  finished = false;
const events = [],
  reads = new Map();
const send = (method, params) => {
  const id = next++;
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return id;
};
send('initialize', {
  clientInfo: { name: 'agent_studio_qa', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
child.stderr.resume();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.id === 1 && v.result) {
      child.stdin.write('{"method":"initialized"}\n');
      send('thread/start', {
        cwd: folder,
        model: 'gpt-5.6-sol',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
        config: { 'features.multi_agent': true, web_search: 'live' },
      });
    } else if (v.id === 2 && v.result) {
      root = v.result.thread.id;
      send('turn/start', {
        threadId: root,
        effort: 'low',
        input: [
          {
            type: 'text',
            text: process.env.QA_SKILL_ONLY
              ? 'Use the capability-check skill in this disposable folder, read its SKILL.md, and reply with its marker. Do not inspect outside this fixture, edit files, search the web, or delegate.'
              : 'Integration test in this disposable folder: use the capability-check skill. Search the web once for IANA example domains. Spawn one sub-agent named fixture-reader to read marker.txt and return the value; do not read it yourself. Wait for it to finish. Do not inspect outside this folder or edit files. Reply with both the skill marker and the sub-agent result and source URL.',
          },
        ],
      });
    }
    if (v.error) events.push({ responseId: v.id, errorCode: v.error.code, error: v.error.message });
    if (reads.has(v.id))
      events.push({
        childRead: true,
        error: !!v.error,
        threadKeys: Object.keys(v.result?.thread ?? {}),
        turns: v.result?.thread?.turns?.map((t) => ({
          status: t.status,
          items: t.items.map((i) => ({ type: i.type, keys: Object.keys(i) })),
        })),
      });
    if (v.method) {
      const p = v.params;
      const e = { method: v.method, parent: p?.threadId === root, keys: Object.keys(p ?? {}) };
      if (p?.item)
        e.item = {
          type: p.item.type,
          kind: p.item.kind,
          keys: Object.keys(p.item),
          status: p.item.status,
          agentsCount: Object.keys(p.item.agentsStates ?? {}).length,
          receivers: p.item.receiverThreadIds?.length,
          tool: p.item.tool,
          readActions: p.item.commandActions?.map((a) => ({
            type: a.type,
            path: a.path?.endsWith('SKILL.md') ? a.path : undefined,
          })),
        };
      if (p?.thread) e.thread = { parent: !!p.thread.parentThreadId, keys: Object.keys(p.thread) };
      if (p?.item?.type === 'subAgentActivity' && p.item.kind === 'completed')
        reads.set(
          send('thread/read', { threadId: p.item.agentThreadId, includeTurns: true }),
          true,
        );
      if (v.method === 'turn/completed' && p?.threadId === root) {
        finished = true;
        setTimeout(() => child.kill(), 2000);
      }
      if (!v.method.includes('delta') && !v.method.startsWith('codex/event/')) events.push(e);
    }
  }
});
const timeout = setTimeout(() => child.kill(), 300000);
await new Promise((resolve, reject) => {
  child.on('close', resolve);
  child.on('error', reject);
});
clearTimeout(timeout);
await writeFile(
  'artifacts/codex-appserver-probe.json',
  JSON.stringify({ finished, events }, null, 2),
);
console.log(
  JSON.stringify({
    finished,
    events: events.filter((e) => e.item?.type === 'subAgentActivity' || e.childRead || e.error),
  }),
);
