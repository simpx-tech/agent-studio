// Opt-in live protocol probe in disposable sessions. Never logs configuration or credentials.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
await mkdir('artifacts/compaction', { recursive: true });
for (const provider of ['claude', 'codex']) {
  const cwd = await mkdtemp(join(tmpdir(), `studio-compact-${provider}-`));
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
          '--input-format',
          'stream-json',
          '--replay-user-messages',
          '--dangerously-skip-permissions',
          '--model',
          'sonnet',
          '--effort',
          'low',
          '--autocompact',
          '100k',
        ],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let phase = 0,
    thread = '';
  const records = [];
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const user = (text) =>
    write({
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  const prompt = 'Remember this test fact: the violet lighthouse code is 7319. Reply only READY.';
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 180000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(`exit:${code}`);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        return;
      }
      const kind = v.method ?? v.type;
      if (!/delta|stream_event/.test(kind ?? ''))
        records.push({
          phase,
          kind,
          id: v.id,
          subtype: v.subtype,
          itemType: v.params?.item?.type,
          status: v.params?.turn?.status,
          compact: v.compact_metadata
            ? {
                trigger: v.compact_metadata.trigger,
                preTokens: v.compact_metadata.pre_tokens,
                postTokens: v.compact_metadata.post_tokens,
              }
            : undefined,
          statusText: v.status,
          content: v.type === 'system' && v.subtype === 'local_command' ? v.content : undefined,
          text:
            v.type === 'result'
              ? v.result
              : v.params?.item?.type === 'agentMessage'
                ? v.params.item.text
                : undefined,
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
      }
      if (v.type === 'result' || v.method === 'turn/completed') {
        if (phase++ === 0) {
          if (provider === 'claude') user('/compact');
          else write({ id: 4, method: 'thread/compact/start', params: { threadId: thread } });
        } else if (phase === 2) {
          if (provider === 'claude') user('What is the lighthouse code? Reply with the code only.');
          else
            write({
              id: 5,
              method: 'turn/start',
              params: {
                threadId: thread,
                effort: 'low',
                input: [
                  { type: 'text', text: 'What is the lighthouse code? Reply with the code only.' },
                ],
              },
            });
        } else {
          clearTimeout(timer);
          resolve('complete');
        }
      }
    });
  });
  child.stderr.resume();
  if (provider === 'claude') user(prompt);
  else
    write({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'compaction_probe', version: '1' } },
    });
  const status = await done;
  spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  await writeFile(
    `artifacts/compaction/${provider}-probe.json`,
    JSON.stringify({ status, records }, null, 2),
  );
  console.log(
    JSON.stringify({
      provider,
      status,
      records: records.filter((r) =>
        /compact|result|completed|local_command/.test(
          (r.kind ?? '') + ' ' + (r.subtype ?? '') + ' ' + (r.itemType ?? ''),
        ),
      ),
    }),
  );
}
