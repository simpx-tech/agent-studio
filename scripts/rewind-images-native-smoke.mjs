// Opt-in native proof that Rewind here returns a message with its image to the composer: the
// image is kept through store_chat_image, read back through read_chat_image and shown as an
// attachment, and Undo rewind takes it back. No provider runs. Build with
// scripts/native-rewind.tauri.json (CDP 9593); REWIND_QA_EXECUTABLE names the built exe.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.rewind-qa';
const executable = resolve(
  process.env.REWIND_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/rewind';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

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
async function connect() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(9593);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(
        () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
      );
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
const page = await connect();
await page.quitOnClose();
const errorBanner = () =>
  page.evaluate(() => document.querySelector('.error-banner')?.textContent.trim() ?? '');
const composer = () => page.evaluate(() => document.querySelector('[aria-label="Message"]').value);
const screenshot = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
const report = { checkedAt: new Date().toISOString() };
try {
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Rewind QA')),
    'Not a disposable Rewind QA workspace',
  );
  // A 64×48 PNG drawn in the page, kept in this computer's image store as a sent message's is.
  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.fillStyle = '#c0392b';
    context.fillRect(0, 0, 64, 48);
    context.fillStyle = '#f1c40f';
    context.fillRect(16, 12, 32, 24);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kept = await window.__TAURI_INTERNALS__.invoke('store_chat_image', bytes);
    return { ...kept, size: bytes.length };
  });
  assert.equal(image.bytes, image.size);
  // The command answers raw bytes, and refuses anything but a hash.
  report.read = await page.evaluate(async (hash) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const bytes = await invoke('read_chat_image', { hash });
    const refused = await invoke('read_chat_image', { hash: '../workspace.json' }).then(
      () => '',
      (error) => String(error),
    );
    return { buffer: bytes instanceof ArrayBuffer, length: bytes.byteLength, refused };
  }, image.hash);
  assert.deepEqual(report.read, { buffer: true, length: image.size, refused: 'Invalid image' });
  const now = new Date().toISOString();
  const chat = {
    id: crypto.randomUUID(),
    title: `Rewind QA images ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'Describe this swatch' }],
        images: [
          {
            id: crypto.randomUUID(),
            name: 'swatch.png',
            mediaType: 'image/png',
            hash: image.hash,
            bytes: image.bytes,
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        runId: crypto.randomUUID(),
        blocks: [{ type: 'markdown', text: 'A yellow square on red.' }],
      },
    ],
  };
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded app lists the chat.
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    if (!current.conversations.some((c) => c.id === chat.id)) current.conversations.push(chat);
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.rewindImagesReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.rewindImagesReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    const opened = await page.evaluate(async (title) => {
      document.querySelector('#conversation-tab-history')?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const row = [...document.querySelectorAll('.conversation-item')].find(
        (e) => e.title === title,
      );
      row?.click();
      return !!row;
    }, chat.title);
    if (opened) break;
    assert(attempt < 5, 'The seeded chat did not survive the app reload');
    await sleep(2000);
  }
  await page.waitFor(() => document.querySelectorAll('.message').length === 2);
  await sleep(3000);
  assert.equal(await errorBanner(), '');
  await page.button('Rewind here');
  await page.waitFor(() => document.querySelectorAll('.message').length === 0);
  assert.equal(await composer(), 'Describe this swatch');
  // The attachment shows the bytes read back, at their own size.
  await page.waitFor(
    () =>
      document.querySelector('[aria-label="Attached images"] img[alt="swatch.png"]')
        ?.naturalWidth === 64,
  );
  report.focused = await page.evaluate(
    () => document.activeElement === document.querySelector('[aria-label="Message"]'),
  );
  assert(report.focused, 'the composer takes focus');
  await screenshot('native-rewind-images');
  await page.button('Undo rewind');
  await page.waitFor(() => document.querySelectorAll('.message').length === 2);
  assert.equal(await composer(), '');
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('[aria-label="Attached images"] img').length),
    0,
  );
  // The undo is saved just after it shows.
  await page.waitFor(async (id) => {
    const { conversations } = await window.__TAURI_INTERNALS__.invoke('load_workspace');
    const saved = conversations.find((c) => c.id === id);
    return saved?.messages.length === 2 && !saved.rewind;
  }, chat.id);
  assert.equal(await errorBanner(), '');
  assert.deepEqual(page.errors, []);
  report.passed = true;
  await writeFile(`${output}/native-images-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page.button('Close window').catch(() => {});
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
