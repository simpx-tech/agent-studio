// Isolated native app -> freezes between the window and the app leave a record
// (docs/DIAGNOSTICS.md): a session that answers writes no report, also while the window is
// minimized; the page's record of the calls it waited on arrives as a windowCalls report; the
// taskbar overlay is set off the window thread; and the app's own --write-minidump helper saves a
// dump of the running app while refusing other processes and names. Build with
// scripts/native-answers.tauri.json and pass the executable in ANSWERS_QA_EXECUTABLE; the driver
// deletes the QA identity's data folder before and after the run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.answers-qa';
const port = 19761;
const executable = resolve(
  process.env.ANSWERS_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const data = join(process.env.LOCALAPPDATA, identifier);
const diagnostics = join(data, 'diagnostics');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const powershell = (args) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    windowsHide: true,
  })
    .toString()
    .trim();
// Only processes of this QA executable, matched by their full path.
const running = () =>
  powershell([
    '-Command',
    `@(Get-Process agent-studio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable.replace(/'/g, "''")}' } | ForEach-Object { $_.Id }) -join ','`,
  ])
    .split(',')
    .filter(Boolean)
    .map(Number);
async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, message);
    await sleep(250);
  }
}
const reports = async () =>
  (await readdir(diagnostics).catch(() => [])).filter((name) => name.endsWith('.json'));
const helper = (...args) =>
  spawnSync(executable, ['--write-minidump', ...args], { windowsHide: true, timeout: 60_000 })
    .status;

assert.deepEqual(running(), [], 'Quit the answers QA app before running this driver.');
await rm(data, { recursive: true, force: true });
const report = { checkedAt: new Date().toISOString(), executable };
let page;
let pid;
try {
  const started = JSON.parse(
    powershell([
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-windows.ps1',
      '-Executable',
      executable,
    ]),
  );
  assert.equal(started.status, 'started', JSON.stringify(started));
  pid = started.processId;
  page = await until(
    async () => {
      try {
        const page = await nativePage(port);
        assert.equal(await page.invoke('plugin:app|identifier'), identifier);
        await page.waitFor(
          () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
        );
        return page;
      } catch {
        return undefined;
      }
    },
    'The QA app did not open its page.',
    60_000,
  );
  await page.quitOnClose();
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );

  // The overlay is set by a thread of its own; the call returns at once either way.
  for (const count of [3, 120, 0]) await page.invoke('set_pending_chat_badge', { count });
  report.overlay = true;

  // A shown window that answers, then a minimized one, leaves no report.
  await sleep(75_000);
  assert.deepEqual(await reports(), [], 'A responsive session wrote a freeze report.');
  await page.invoke('plugin:window|minimize', { label: 'main' });
  await sleep(75_000);
  assert.deepEqual(await reports(), [], 'A minimized session wrote a freeze report.');
  report.quiet = true;

  // The page's record of the calls it waited on.
  await page.invoke('record_window_stall', {
    stall: {
      noticedAt: Date.now(),
      unansweredMs: 20_000,
      answeredAfterMs: 31_000,
      calls: [{ command: 'save_workspace_patch', waitedMs: 7_200_000 }],
    },
  });
  const [calls] = await reports();
  assert.match(calls, /-windowCalls\.json$/);
  const recorded = JSON.parse(await readFile(join(diagnostics, calls), 'utf8'));
  assert.equal(recorded.kind, 'windowCalls');
  assert.equal(recorded.recoveredAfterMs, 31_000);
  assert.deepEqual(recorded.calls, [{ command: 'save_workspace_patch', waitedMs: 7_200_000 }]);
  await assert.rejects(
    page.invoke('record_window_stall', {
      stall: {
        noticedAt: 1,
        unansweredMs: 1,
        answeredAfterMs: null,
        calls: [{ command: 'C:\\x', waitedMs: 1 }],
      },
    }),
  );
  report.windowCalls = true;

  // The minidump helper: this app's process only, under a plain name.
  assert.equal(helper(String(pid), 'smoke-check'), 0);
  assert((await stat(join(diagnostics, 'smoke-check.dmp'))).size > 100_000);
  assert.equal(helper(String(process.pid), 'other-program'), 2);
  assert.equal(helper(String(pid), '..\\escape'), 2);
  assert.equal(helper(String(pid)), 2);
  report.minidump = true;

  await page.button('Close window');
  await until(async () => !running().includes(pid), 'The QA app did not quit.', 30_000);
  pid = undefined;
  console.log(JSON.stringify({ ...report, passed: true }, null, 2));
} finally {
  page?.close();
  if (pid) powershell(['-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
  await until(async () => running().length === 0, 'The QA app is still running.', 30_000).catch(
    () => {},
  );
  await rm(data, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
