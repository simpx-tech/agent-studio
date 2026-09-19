// Opt-in: compare native steering with streamed human input in disposable sessions.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
await mkdir('artifacts/steering', { recursive: true });
for (const provider of ['codex', 'claude']) {
  const cwd = await mkdtemp(join(tmpdir(), `studio-steer-${provider}-`));
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDECODE;
  const child = spawn(
    provider === 'codex'
      ? join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe')
      : join(homedir(), '.local/bin/claude.exe'),
    provider === 'codex'
      ? ['app-server', '--stdio']
      : [
          '--print',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--input-format',
          'stream-json',
          '--replay-user-messages',
          '--no-session-persistence',
          '--dangerously-skip-permissions',
          '--model',
          'sonnet',
          '--effort',
          'low',
        ],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const records = [];
  let thread = '',
    turn = '',
    sent = false,
    text = '';
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const prompt =
    'Use your shell tool to sleep for 8 seconds, then reply ORIGINAL. Do not use background execution.';
  const steer = 'Change the final reply to STEERING_CONFIRMED instead of ORIGINAL.';
  const user = (text, uuid) =>
    write({
      type: 'user',
      uuid,
      origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  if (provider === 'codex')
    write({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'steering_probe', version: '1' } },
    });
  else user(prompt, '11111111-1111-4111-8111-111111111111');
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 120000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        return;
      }
      const kind = v.method ?? v.type;
      if (!/delta|stream_event/.test(kind))
        records.push({
          kind,
          id: v.id,
          type: v.params?.item?.type,
          uuid: v.uuid,
          subtype: v.subtype,
          turn: v.params?.turn?.id,
          result: v.type === 'result' ? v.result : v.id === 4 ? v.result : undefined,
          error: v.error,
        });
      if (provider === 'codex') {
        if (v.id === 1) {
          write({ method: 'initialized' });
          write({
            id: 2,
            method: 'thread/start',
            params: {
              model: 'gpt-5.6-sol',
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              ephemeral: true,
            },
          });
        }
        if (v.id === 2) {
          thread = v.result.thread.id;
          write({
            id: 3,
            method: 'turn/start',
            params: { threadId: thread, effort: 'low', input: [{ type: 'text', text: prompt }] },
          });
        }
        if (v.id === 3) turn = v.result.turn.id;
        if (v.method === 'item/started' && v.params?.item?.type === 'commandExecution' && !sent) {
          sent = true;
          write({
            id: 4,
            method: 'turn/steer',
            params: {
              threadId: thread,
              expectedTurnId: turn,
              input: [{ type: 'text', text: steer }],
            },
          });
        }
        if (v.method === 'item/agentMessage/delta') text += v.params.delta;
        if (v.method === 'turn/completed') {
          clearTimeout(timer);
          resolve('complete');
        }
      } else {
        if (
          v.type === 'assistant' &&
          v.message?.content?.some((b) => b.type === 'tool_use') &&
          !sent
        ) {
          sent = true;
          user(steer, '22222222-2222-4222-8222-222222222222');
        }
        if (v.type === 'result') {
          text += v.result;
          clearTimeout(timer);
          resolve('complete');
        }
      }
    });
  });
  child.stderr.resume();
  const status = await done;
  spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  const report = { provider, status, sent, text, records };
  await writeFile(`artifacts/steering/${provider}-probe.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ provider, status, sent, text }));
}
