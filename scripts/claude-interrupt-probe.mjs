// Opt-in protocol probe: does one Claude stream-json process accept an in-band
// interrupt and then a second human turn? Writes artifacts/claude-interrupt-probe.json.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const cwd = await mkdtemp(join(tmpdir(), 'studio-claude-interrupt-'));
const child = spawn(
  join(homedir(), '.local/bin/claude.exe'),
  [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--tools',
    'default',
    '--dangerously-skip-permissions',
    '--permission-prompt-tool',
    'stdio',
    '--model',
    'sonnet',
    '--effort',
    'low',
  ],
  { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
const records = [];
let phase = 'init';
let interruptedAt = 0;
const started = Date.now();
const note = (v) => {
  records.push({
    at: Date.now() - started,
    phase,
    type: v.type,
    subtype: v.subtype,
    isError: v.is_error,
    numTurns: v.num_turns,
    requestId: v.request_id ?? v.response?.request_id,
    responseSubtype: v.response?.subtype,
    error: v.response?.error,
    result: typeof v.result === 'string' ? v.result.slice(0, 80) : undefined,
    text:
      v.type === 'assistant' ? JSON.stringify(v.message?.content ?? '').slice(0, 120) : undefined,
  });
};
const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
const user = (text) =>
  write({
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
const timer = setTimeout(() => {
  records.push({ at: Date.now() - started, phase, type: 'probe-timeout' });
  spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
}, 180000);
let deltas = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  if (v.type === 'stream_event') {
    if (v.event?.delta?.type === 'text_delta') {
      deltas++;
      if (phase === 'first' && deltas >= 3) {
        phase = 'interrupting';
        interruptedAt = Date.now();
        write({
          type: 'control_request',
          request_id: 'studio-interrupt-1',
          request: { subtype: 'interrupt' },
        });
      }
    }
    return;
  }
  note(v);
  if (
    phase === 'init' &&
    v.type === 'control_response' &&
    v.response?.request_id === 'studio-init'
  ) {
    phase = 'first';
    user(
      'Write the numbers from 1 to 400, one per line, with a short unique sentence after each number. Do not use tools.',
    );
    return;
  }
  if (phase === 'interrupting' && v.type === 'result') {
    records.push({
      at: Date.now() - started,
      phase,
      type: 'probe-note',
      text: `result after interrupt in ${Date.now() - interruptedAt} ms`,
    });
    phase = 'second';
    user('Reply with exactly SECOND_TURN_OK and nothing else. Do not use tools.');
    return;
  }
  if (phase === 'second' && v.type === 'result') {
    phase = 'done';
    child.stdin.end();
  }
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text)
    records.push({ at: Date.now() - started, phase, type: 'stderr', text: text.slice(0, 300) });
});
child.on('exit', async (code) => {
  clearTimeout(timer);
  const secondResult = records.find((r) => r.phase === 'second' && r.type === 'result');
  const summary = {
    checkedAt: new Date().toISOString(),
    exitCode: code,
    interruptAcknowledged: records.some(
      (r) => r.type === 'control_response' && r.requestId === 'studio-interrupt-1',
    ),
    resultAfterInterrupt: records.find((r) => r.phase === 'interrupting' && r.type === 'result'),
    secondTurnOk: !!secondResult && String(secondResult.result).includes('SECOND_TURN_OK'),
    records,
  };
  await writeFile('artifacts/claude-interrupt-probe.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, records: undefined }, null, 2));
});
write({
  type: 'control_request',
  request_id: 'studio-init',
  request: { subtype: 'initialize', hooks: null },
});
