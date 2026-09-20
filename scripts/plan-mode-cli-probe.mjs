// Opt-in protocol probe in a disposable directory; never changes CLI profiles.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const cwd = await mkdtemp(join(tmpdir(), 'studio-plan-probe-'));
await mkdir('artifacts/plan-mode', { recursive: true });
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CODEX_THREAD_ID;
const initialPlan = process.argv.includes('--plan');
const child = spawn(
  join(homedir(), '.local/bin/claude.exe'),
  [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    '--no-session-persistence',
    ...(initialPlan
      ? ['--permission-mode', 'plan', '--allow-dangerously-skip-permissions']
      : ['--dangerously-skip-permissions']),
    '--permission-prompt-tool',
    'stdio',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--settings',
    JSON.stringify({ permissions: { ask: ['EnterPlanMode', 'ExitPlanMode'] } }),
  ],
  { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const records = [];
const send = (v) => child.stdin.write(JSON.stringify(v) + '\n');
send({
  type: 'control_request',
  request_id: 'init',
  request: { subtype: 'initialize', hooks: null },
});
let timer;
const outcome = await new Promise((resolve) => {
  timer = setTimeout(() => resolve('timeout'), 180000);
  child.on('error', (e) => resolve(e.message));
  child.stderr.on('data', () => {});
  createInterface({ input: child.stdout }).on('line', (line) => {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    if (v.type === 'control_response' && v.response.request_id === 'init') {
      records.push({ type: 'initialized', status: v.response.subtype });
      send({
        type: 'user',
        origin: { kind: 'human' },
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: initialPlan
                ? 'Make a short plan to add a hello.txt file containing HELLO in this disposable directory. Use ExitPlanMode to request approval. Do not write hello.txt until approved. After approval, write it, then reply DONE.'
                : 'First call EnterPlanMode. Then make a short plan to add hello.txt containing HELLO in this disposable directory. Use ExitPlanMode for approval. After approval, write it, then reply DONE.',
            },
          ],
        },
      });
    }
    if (v.type === 'system' && ['init', 'status'].includes(v.subtype))
      records.push({ type: v.type, subtype: v.subtype, permissionMode: v.permissionMode });
    if (v.type === 'assistant')
      for (const b of v.message.content ?? [])
        if (b.type === 'tool_use')
          records.push({ type: 'tool', name: b.name, id: b.id, input: b.input });
    if (v.type === 'user' && v.tool_use_result)
      records.push({ type: 'tool_result', result: v.tool_use_result });
    if (v.type === 'control_request') {
      records.push({ type: v.type, request: v.request });
      const r = v.request;
      const allow = ['EnterPlanMode', 'ExitPlanMode'].includes(r.tool_name);
      const response = allow
        ? {
            behavior: 'allow',
            updatedInput: r.input,
            updatedPermissions: [
              {
                type: 'setMode',
                mode: r.tool_name === 'EnterPlanMode' ? 'plan' : 'bypassPermissions',
                destination: 'session',
              },
            ],
          }
        : { behavior: 'deny', message: 'Remain in plan mode until ExitPlanMode is approved.' };
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: v.request_id, response },
      });
    }
    if (v.type === 'result') {
      records.push({ type: 'result', subtype: v.subtype, result: v.result });
      resolve(v.subtype);
    }
  });
});
clearTimeout(timer);
child.kill();
const report = { initialPlan, cwd, outcome, records };
await writeFile(
  `artifacts/plan-mode/claude-${initialPlan ? 'plan' : 'enter'}-probe.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
