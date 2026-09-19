// Opt-in protocol probe: does one Codex app-server process accept turn/interrupt
// and then a second turn/start on the same thread? Writes artifacts/codex-interrupt-probe.json.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const cwd = await mkdtemp(join(tmpdir(), 'studio-codex-interrupt-'));
const env = { ...process.env };
delete env.CODEX_THREAD_ID;
delete env.CLAUDECODE;
const child = spawn(
  join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe'),
  [
    'app-server',
    '--stdio',
    '-c',
    'features.shell_tool=true',
    '-c',
    'features.apply_patch_freeform=true',
  ],
  { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const records = [];
const started = Date.now();
let next = 1,
  thread = '',
  turn = '',
  phase = 'init',
  deltas = 0,
  interruptedAt = 0,
  secondText = '';
const send = (method, params) => {
  const id = next++;
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return id;
};
const ids = {};
const timer = setTimeout(() => {
  records.push({ at: Date.now() - started, phase, type: 'probe-timeout' });
  spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
}, 180000);
ids.init = send('initialize', {
  clientInfo: { name: 'agent_studio_qa', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text)
    records.push({ at: Date.now() - started, phase, type: 'stderr', text: text.slice(0, 300) });
});
createInterface({ input: child.stdout }).on('line', (line) => {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  if (v.method !== 'item/agentMessage/delta' && v.method !== 'item/reasoning/delta')
    records.push({
      at: Date.now() - started,
      phase,
      id: v.id,
      method: v.method,
      status: v.params?.turn?.status,
      error: v.error,
      keys: v.result ? Object.keys(v.result) : undefined,
    });
  if (v.id === ids.init && v.result) {
    child.stdin.write('{"method":"initialized"}\n');
    ids.thread = send('thread/start', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
    });
    return;
  }
  if (v.id === ids.thread && v.result) {
    thread = v.result.thread.id;
    phase = 'first';
    ids.turn1 = send('turn/start', {
      threadId: thread,
      effort: 'low',
      input: [
        {
          type: 'text',
          text: 'Write the numbers from 1 to 400, one per line, with a short unique sentence after each number. Do not use tools.',
          text_elements: [],
        },
      ],
    });
    return;
  }
  if (v.method === 'turn/started' && v.params?.threadId === thread) turn = v.params.turn.id;
  if (v.method === 'item/agentMessage/delta' && phase === 'first') {
    deltas++;
    if (deltas >= 3) {
      phase = 'interrupting';
      interruptedAt = Date.now();
      ids.interrupt = send('turn/interrupt', { threadId: thread, turnId: turn });
    }
    return;
  }
  if (v.method === 'item/agentMessage/delta' && phase === 'second') {
    secondText += v.params?.delta ?? '';
    return;
  }
  if (v.method === 'turn/completed' && phase === 'interrupting') {
    records.push({
      at: Date.now() - started,
      phase,
      type: 'probe-note',
      text: `turn/completed ${v.params?.turn?.status} after interrupt in ${Date.now() - interruptedAt} ms`,
    });
    phase = 'second';
    ids.turn2 = send('turn/start', {
      threadId: thread,
      effort: 'low',
      input: [
        {
          type: 'text',
          text: 'Reply with exactly SECOND_TURN_OK and nothing else. Do not use tools.',
          text_elements: [],
        },
      ],
    });
    return;
  }
  if (v.method === 'turn/completed' && phase === 'second') {
    phase = 'done';
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }
});
child.on('exit', async (code) => {
  clearTimeout(timer);
  const summary = {
    checkedAt: new Date().toISOString(),
    exitCode: code,
    interruptStatus: records.find(
      (r) => r.phase === 'interrupting' && r.method === 'turn/completed',
    )?.status,
    secondTurnOk: secondText.includes('SECOND_TURN_OK'),
    secondTurnStatus: records.find((r) => r.phase === 'second' && r.method === 'turn/completed')
      ?.status,
    records,
  };
  await writeFile('artifacts/codex-interrupt-probe.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, records: undefined }, null, 2));
});
