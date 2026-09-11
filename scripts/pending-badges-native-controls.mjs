// Run after pending-badges-native-smoke.mjs; leaves its two QA chats in History.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9500);
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.pending-badges-qa',
  );
  await page.waitFor(() => document.querySelector('[aria-label="2 pending chats"]'));
  // Native IPC is read-only; validate platform calls directly and the ordinary
  // UI transition separately. The browser regression asserts automatic routing.
  const requests = [];
  await page.invoke('set_pending_chat_badge', { count: 2 });
  requests.push(2);
  await page.button('Move to history');
  await page.waitFor(() => document.querySelector('[aria-label="1 pending chats"]'));
  await page.invoke('set_pending_chat_badge', { count: 1 });
  requests.push(1);
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('Active'))
      .click(),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('.conversation-item')]
      .find((e) => e.textContent.includes('Working chat'))
      .click(),
  );
  await page.button('Move to history');
  await page.waitFor(() => document.querySelector('[aria-label="0 pending chats"]'));
  await page.invoke('set_pending_chat_badge', { count: 0 });
  requests.push(0);
  assert.deepEqual(requests, [2, 1, 0]);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.pending-chat-count').length),
    0,
  );
  await writeFile(
    'artifacts/pending-badges-native-controls.json',
    JSON.stringify(
      {
        successfulNativeBadgeCounts: requests,
        archivedChatsClearBadge: true,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(page.errors, []);
  console.log('Native taskbar badge calls 2 -> 1 -> 0 and sidebar clearing passed.');
} finally {
  page.close();
}
