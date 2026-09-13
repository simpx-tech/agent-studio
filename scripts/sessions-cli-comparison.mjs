// Small controlled CLI baseline and the old display-only replay control.
// Uses existing authentication without reading it. Facts and folders are disposable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const source = JSON.parse(await readFile('artifacts/sessions/native-report.json', 'utf8'));
const firstPrompt =
  'Read continuity-fixture.txt with a file or shell tool. Remember its three facts for a later question. Do not write files, use other tools, or delegate. Reply exactly READY; do not include any fixture fact in your final answer.';
const nextPrompt =
  'Without using any tools, return the exact three facts from the file you read earlier as JSON with code, threshold, and equality. The file has been removed. Use only your existing conversation context.';
const executables = {
  claude: join(homedir(), '.local/bin/claude.exe'),
  codex: join(homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'),
};
async function run(provider, cwd, prompt, session) {
  const args =
    provider === 'claude'
      ? [
          '--print',
          '--output-format',
          'stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
          '--model',
          'sonnet',
          '--effort',
          'low',
          ...(session ? ['--resume', session] : ['--session-id', crypto.randomUUID()]),
        ]
      : [
          'exec',
          ...(session ? ['resume'] : []),
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--model',
          'gpt-5.6-sol',
          '-c',
          'model_reasoning_effort="low"',
          ...(session ? [session] : []),
          '-',
        ];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  const start = Date.now();
  const child = spawn(executables[provider], args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  child.stdin.end(prompt);
  const timer = setTimeout(
    () =>
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      }),
    180000,
  );
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  assert.equal(code, 0, `${provider} baseline process failed`);
  const events = output.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const result =
    provider === 'claude'
      ? events.findLast((e) => e.type === 'result')
      : events.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
  const text = provider === 'claude' ? result?.result : result?.item?.text;
  assert(text, `${provider} did not supply a final result`);
  const id =
    provider === 'claude'
      ? result.session_id
      : events.find((e) => e.type === 'thread.started')?.thread_id;
  assert(id, `${provider} did not supply a session identity`);
  return { id, text, elapsedMs: Date.now() - start };
}
const report = { checkedAt: new Date().toISOString(), runs: [] };
for (const chat of source.chats) {
  const cwd = await mkdtemp(join(tmpdir(), `studio-baseline-${chat.provider}-`));
  await writeFile(join(cwd, 'continuity-fixture.txt'), JSON.stringify(chat.facts));
  const first = await run(chat.provider, cwd, firstPrompt);
  assert.equal(first.text.trim(), 'READY');
  await unlink(join(cwd, 'continuity-fixture.txt'));
  const second = await run(chat.provider, cwd, nextPrompt, first.id);
  assert(second.text.includes(chat.facts.code), `${chat.provider} baseline lost facts`);
  const replay = await run(
    chat.provider,
    cwd,
    `Answer the final user message using this saved conversation: ${JSON.stringify([
      { role: 'user', text: firstPrompt },
      { role: 'assistant', text: 'READY' },
      { role: 'user', text: nextPrompt },
    ])}`,
  );
  assert(
    !replay.text.includes(chat.facts.code),
    'The random fixture must not be available in display-only replay',
  );
  report.runs.push({
    provider: chat.provider,
    version: spawnSync(executables[chat.provider], ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim(),
    first,
    second,
    replay,
    appRecallPassed: chat.second?.text.includes(chat.facts.code) ?? null,
  });
  await writeFile('artifacts/sessions/comparison-report.json', JSON.stringify(report, null, 2));
  console.log(`${chat.provider}: native resume recalled facts; display-only replay did not`);
}
