// Isolated native app -> app sessions across a page reload, a title-bar close and a relaunch.
// Build with scripts/native-history-sessions.tauri.json; this script never asks a provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.history-sessions-qa';
const port = Number(process.env.HISTORY_QA_PORT ?? 19731);
const executable = resolve(
  process.env.HISTORY_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/history-sessions';
const chatTitle = 'History QA chat';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

// Task Scheduler launch: normal Windows storage, never an inherited packaged-app context.
function launch() {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-windows.ps1',
      '-Executable',
      executable,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
const ready = () => document.querySelector('.template-button')?.disabled === false;
const banner = (page) =>
  page.evaluate(() => document.querySelector('.error-banner')?.textContent.trim() ?? '');
// Reading workspace.json while the startup save replaces it can fail that save on Windows, so
// the driver reads the file only after startup has saved.
async function settle(page) {
  await sleep(3000);
  assert.equal(await banner(page), '');
}
async function open() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(ready);
      await settle(page);
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
// Only this build's process counts; other Agent Studio installations are never touched.
function qaRunning() {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'agent-studio.exe\'" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress',
    ],
    { windowsHide: true },
  )
    .toString()
    .trim();
  return [raw ? JSON.parse(raw) : []]
    .flat()
    .some((path) => path?.toLowerCase() === executable.toLowerCase());
}
async function closeWindow(page) {
  await page.button('Close window');
  page.close();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!qaRunning()) return;
    await sleep(250);
  }
  throw new Error('The History Sessions QA app did not close.');
}
// Each History heading with the chats listed under it.
const headings = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#conversation-panel-history .conversation-session')].map(
      (section) => [
        section.querySelector('.session-group-toggle').textContent.trim(),
        section.querySelector('.session-group-toggle').title,
        [...section.querySelectorAll('.conversation-item')].map((row) => row.textContent.trim()),
      ],
    ),
  );
const label = (page, time) =>
  page.evaluate(
    (time) =>
      `Today, ${new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    time,
  );
async function screenshot(page, name) {
  await page.evaluate(() => document.querySelector('#conversation-tab-history')?.click());
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, name), Buffer.from(shot.data, 'base64'));
}

launch();
let page = await open();
try {
  const installation = await page.invoke('get_installation');
  const initial = await page.invoke('load_workspace');
  assert(
    initial.conversations.every((c) => c.title.startsWith('History QA')),
    'Use only a disposable History QA workspace.',
  );
  // The app records the start of its process once.
  const first = await page.invoke('app_session');
  assert.equal(typeof first.id, 'string');
  assert(Math.abs(Date.now() - first.startedAt) < 120_000, 'The session starts with the app.');
  const firstStart = new Date(first.startedAt).toISOString();
  assert.deepEqual((await page.invoke('load_workspace')).appSessions.at(-1), {
    id: first.id,
    environmentId: installation.id,
    startedAt: firstStart,
  });
  // A chat used in this session, then a page reload: the same process keeps its session.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await page.invoke('load_workspace');
    if (!current.conversations.some((c) => c.title === chatTitle)) {
      const now = new Date().toISOString();
      current.conversations.push({
        id: crypto.randomUUID(),
        title: chatTitle,
        settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'user',
            status: 'complete',
            createdAt: now,
            blocks: [{ type: 'markdown', text: 'Seeded question.' }],
          },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            status: 'complete',
            createdAt: now,
            blocks: [{ type: 'markdown', text: 'Seeded answer. No provider was asked.' }],
          },
        ],
      });
      await page.invoke('save_workspace', { workspace: current });
    }
    await page.evaluate(() => (window.historyQaReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.historyQaReload && document.querySelector('.template-button')?.disabled === false,
    );
    const shown = await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')].some(
          (row) => row.textContent.trim() === title,
        ),
      chatTitle,
    );
    if (shown) break;
    assert(attempt < 2, 'The seeded chat did not load.');
  }
  await settle(page);
  assert.equal((await page.invoke('app_session')).id, first.id);
  const reloaded = (await page.invoke('load_workspace')).appSessions;
  assert.deepEqual(
    reloaded.map((s) => s.id),
    [first.id],
  );
  await page.evaluate(() => document.querySelector('#conversation-tab-history')?.click());
  assert.deepEqual(await headings(page), [
    [
      await label(page, first.startedAt),
      `App session started ${await page.evaluate(
        (time) => new Date(time).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }),
        first.startedAt,
      )} on ${installation.name}`,
      [chatTitle],
    ],
  ]);
  assert.equal(await banner(page), '');
  await screenshot(page, 'native-reloaded.png');
  await closeWindow(page);

  // Starting the app again opens a new session; the first keeps its chat.
  launch();
  page = await open();
  const second = await page.invoke('app_session');
  assert.notEqual(second.id, first.id);
  assert(second.startedAt > first.startedAt);
  const sessions = (await page.invoke('load_workspace')).appSessions;
  assert.deepEqual(
    sessions.map((s) => s.id),
    [first.id, second.id],
  );
  await page.evaluate(() => document.querySelector('#conversation-tab-history')?.click());
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('#conversation-panel-history .conversation-item')].some(
        (row) => row.textContent.trim() === title,
      ),
    chatTitle,
  );
  const listed = await headings(page);
  assert.deepEqual(
    listed.map(([name, , chats]) => [name, chats]),
    [[await label(page, first.startedAt), [chatTitle]]],
  );
  assert.equal(await banner(page), '');
  await screenshot(page, 'native-relaunched.png');
  assert.deepEqual(page.errors, []);
  await closeWindow(page);
  console.log(
    JSON.stringify({ first: first.id, second: second.id, headings: listed.map(([name]) => name) }),
  );
  process.exit(0);
} catch (error) {
  page.close();
  throw error;
}
