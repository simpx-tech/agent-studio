// Opt-in: two real Codex replies in the isolated native-replies.tauri.json app (CDP 9440).
// Uses an empty QA workspace and a dedicated fixture folder; never replaces user conversations.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9440);
const pick = async (label, name) => {
  await page.click(`[role="combobox"][aria-label="${label}"]`);
  await page.waitFor(
    (name) => !!document.querySelector(`[role="option"][aria-label="${name}"]`),
    name,
  );
  await page.click(`[role="option"][aria-label="${name}"]`);
};
const fill = (label, value) =>
  page.evaluate(
    (label, value) => {
      const input = document.querySelector(`[aria-label="${label}"]`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
const screenshot = async (name) => {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/replies-native-${name}.png`, Buffer.from(data, 'base64'));
};
const finish = async () => {
  const deadline = Date.now() + 180000;
  while (await page.evaluate(() => !!document.querySelector('.message[data-status="running"]'))) {
    assert(Date.now() < deadline, 'Real provider reply timed out.');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll('.message')].at(-1)?.dataset.status),
    'complete',
  );
};
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.replies-qa');
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const before = await page.invoke('load_workspace');
  assert.equal(
    before.conversations.length,
    0,
    'Use a fresh QA workspace; preserve existing conversations.',
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
    '',
  );

  // Double-click uses Tauri's same injected drag-region hit test, with an observable native result.
  // Do not monkey-patch invoke: native Tauri exposes it as a non-writable property.
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('.brand').getAttribute('data-tauri-drag-region'),
    ),
    'deep',
  );
  const initiallyMaximized = await page.invoke('plugin:window|is_maximized');
  for (const [selector, maximized] of [
    ['.brand-light', !initiallyMaximized],
    ['.brand-mark circle', initiallyMaximized],
  ]) {
    await page.evaluate(
      (selector) =>
        document
          .querySelector(selector)
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 })),
      selector,
    );
    await page.waitFor(
      async (maximized) =>
        (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized')) === maximized,
      maximized,
    );
  }
  await page.button('Connections');
  await page.button('Back to conversation');
  await page.waitFor(() => !!document.querySelector('[aria-label="Message"]'));

  const directory = resolve('artifacts/replies-native-fixture');
  await mkdir(directory, { recursive: true });
  const selectedFolder = await page.evaluate(() =>
    document.querySelector('[role="combobox"][aria-label="Folder"]')?.getAttribute('title'),
  );
  if (selectedFolder !== directory) {
    await page.button('Choose folder');
    await page.waitFor(
      () => document.querySelector('.folder-entries')?.getAttribute('aria-busy') === 'false',
    );
    await fill('Folder path', directory);
    await page.button('Go');
    await page.waitFor(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent.trim() === 'Use this folder' && !b.disabled,
      ),
    );
    await page.button('Use this folder');
  }
  await page.waitFor(
    () =>
      !document.querySelector('[role="dialog"]') &&
      !document.querySelector('[role="combobox"][aria-label="Model"]').disabled,
  );
  await pick('Model', 'GPT-6-Astra');
  await pick('Reasoning', 'Low');
  await fill('Message', 'Reply with exactly FIRST_MODEL_OK. Do not use tools.');
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  await page.waitFor(() => !!document.querySelector('.message[data-status="running"]'));
  await pick('Model', 'GPT-5.6-Sol');
  await pick('Reasoning', 'High');
  assert.equal(
    await page.evaluate(() => document.querySelector('.next-reply-settings')?.textContent.trim()),
    'Next message: GPT-5.6-Sol · High reasoning',
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.message[data-status="running"] .message-heading strong')
          ?.textContent,
    ),
    'GPT-6-Astra',
  );
  await screenshot('pending');
  await finish();
  assert.equal(
    await page.evaluate(() => document.querySelector('.prose')?.textContent.trim()),
    'FIRST_MODEL_OK',
  );

  await fill('Message', 'Now reply with exactly SECOND_MODEL_OK. Do not use tools.');
  await page.button('Send message');
  await page.waitFor(() => !!document.querySelector('.reply-switch'));
  assert.equal(
    await page.evaluate(() => document.querySelector('.reply-switch').textContent.trim()),
    'Switched to GPT-5.6-Sol · High reasoning',
  );
  assert.equal(
    await page.evaluate(() => !!document.querySelector('.message[data-status="running"] .prose')),
    false,
  );
  await screenshot('switched');
  await finish();
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll('.prose')].at(-1)?.textContent.trim()),
    'SECOND_MODEL_OK',
  );
  await page.waitFor(async () => {
    const workspace = await window.__TAURI_INTERNALS__.invoke('load_workspace');
    return workspace.conversations[0]?.messages.at(-1)?.status === 'complete';
  });
  const saved = await page.invoke('load_workspace');
  const replies = saved.conversations[0].messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(
    replies.map((m) => [m.settings.model, m.settings.reasoning]),
    [
      ['gpt-6-astra', 'low'],
      ['gpt-5.6-sol', 'high'],
    ],
  );
  assert.deepEqual(
    replies.map((m) => m.modelName),
    ['GPT-6-Astra', 'GPT-5.6-Sol'],
  );
  assert.equal(await page.evaluate(() => !!document.querySelector('.message-execution')), false);
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await page.button(saved.conversations[0].title);
  await page.waitFor(() => document.querySelectorAll('.prose').length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.message-heading strong')].map((e) => e.textContent),
    ),
    ['You', 'GPT-6-Astra', 'You', 'GPT-5.6-Sol'],
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('.reply-switch').textContent.trim()),
    'Switched to GPT-5.6-Sol · High reasoning',
  );
  await screenshot('complete');
  assert.deepEqual(page.errors, []);
  const result = {
    checkedAt: new Date().toISOString(),
    logoNativeDragRegion: 'deep',
    logoDescendantsToggleNativeMaximize: true,
    physicalDragMovementVerified: false,
    settingsEditableDuringRealReply: true,
    nextReplyNoticeBeforeProviderText: true,
    historySurvivesNativeReload: true,
    executionSubtitleRemoved: true,
    realReplyCount: 2,
    backgroundTitleRequested: true,
    replies: replies.map((m) => ({
      model: m.settings.model,
      reasoning: m.settings.reasoning,
      name: m.modelName,
      status: m.status,
    })),
    errors: page.errors,
  };
  await writeFile('artifacts/replies-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  page.close();
}
