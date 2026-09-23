// Isolated native UI -> real drafts.json across a title-bar close and a relaunch.
// Build with scripts/native-drafts.tauri.json; this script never sends a message to a provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.drafts-qa';
const port = Number(process.env.DRAFTS_QA_PORT ?? 19682);
const executable = resolve(
  process.env.DRAFTS_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const data = join(process.env.LOCALAPPDATA, identifier);
const output = 'artifacts/drafts';
const chatTitle = 'Drafts QA chat';
const nonce = crypto.randomUUID().slice(0, 8);
const chatDraft = `Drafts QA reply draft ${nonce}`;
const newChatDraft = `Drafts QA new chat draft ${nonce}`;
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
async function open() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(() => document.querySelector('.template-button')?.disabled === false);
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
const fill = (page, value) =>
  page.evaluate((value) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
async function openChat(page) {
  await page.evaluate(() => document.querySelector('#conversation-tab-history')?.click());
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((row) => row.textContent.trim() === title)
        ?.click(),
    chatTitle,
  );
  await page.waitFor(
    (title) => document.querySelector('.page-title')?.textContent === title,
    chatTitle,
  );
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
// Closing right after typing exercises the title bar's save before the window closes.
async function closeWindow(page) {
  await page.button('Close window');
  page.close();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!qaRunning()) return;
    await sleep(250);
  }
  throw new Error('The Drafts QA app did not close.');
}
const savedDrafts = async () =>
  JSON.parse(await readFile(join(data, 'drafts.json'), 'utf8')).drafts.filter((draft) =>
    draft.text.includes(nonce),
  );

launch();
let page = await open();
const errors = [];
try {
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const initial = await page.invoke('load_workspace');
  assert(
    initial.conversations.every((c) => c.title.startsWith('Drafts QA')),
    'Use only a disposable Drafts QA workspace.',
  );
  // A saved chat without a provider request: seed it, then reload so the app loads it.
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
    await page.evaluate(() => (window.draftsQaReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.draftsQaReload && document.querySelector('.template-button')?.disabled === false,
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
  // The startup composer is a new chat; its draft belongs to its location.
  await fill(page, newChatDraft);
  await openChat(page);
  await fill(page, chatDraft);
  errors.push(...page.errors);
  await closeWindow(page);

  const afterClose = await savedDrafts();
  assert.deepEqual(afterClose.map((draft) => draft.text).sort(), [chatDraft, newChatDraft].sort());
  assert(afterClose.find((draft) => draft.text === chatDraft).key.startsWith('chat:'));
  assert(afterClose.find((draft) => draft.text === newChatDraft).key.startsWith('folder:'));
  assert(
    !(await readFile(join(data, 'workspace.json'), 'utf8')).includes(nonce),
    'Drafts must stay out of the portable workspace.',
  );

  launch();
  page = await open();
  await page.waitFor(
    (text) => document.querySelector('[aria-label="Message"]')?.value === text,
    newChatDraft,
  );
  await fill(page, '');
  await openChat(page);
  await page.waitFor(
    (text) => document.querySelector('[aria-label="Message"]')?.value === text,
    chatDraft,
  );
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'native-restored.png'), Buffer.from(shot.data, 'base64'));
  // Leave the QA profile tidy: an emptied composer removes its saved draft.
  await fill(page, '');
  errors.push(...page.errors);
  await closeWindow(page);
  assert.deepEqual(await savedDrafts(), []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'native-result.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        identifier,
        savedOnClose: afterClose.map(({ key, text }) => ({ key: key.split(':')[0], text })),
        restoredAfterRelaunch: { newChat: true, chat: true },
        workspaceExcludesDrafts: true,
        clearedDraftsRemoved: true,
        runtimeErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'DRAFTS_NATIVE_PASSED: drafts saved on title-bar close, restored after relaunch per chat and new-chat location, kept out of workspace.json, and removed when cleared.',
  );
} finally {
  page.close();
}
