import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9428');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://tauri.localhost/'));
if (!page) throw new Error('Packaged app was not found');
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
await expect(page.getByText('Local desktop', { exact: true })).toBeVisible();
await page.getByRole('button', { name: 'Chat with Codex', exact: true }).click();
await page
  .getByLabel('Message', { exact: true })
  .fill('Release verification: reply with only STUDIO_READY.');
await page.getByRole('button', { name: 'Send message' }).click();
await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
  'data-status',
  'complete',
  { timeout: 90000 },
);
await expect(page.locator('.prose').last()).toContainText('STUDIO_READY');
// Remove only the exact synthetic conversations created by these opt-in smoke scripts.
// Any user-created conversation with different content is left intact.
const removed = await page.evaluate(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const data = await invoke('load_workspace', {});
  const prompts = [
    'The word to remember for this test is maple. Reply only with: Noted.',
    'Cancellation verification: explain how a rainbow forms in detail.',
    'Write a short welcome guide for a personal AI workspace. Use the heading "Your next idea starts here", three bullet points, a small table comparing Agents and Conversations, and a JavaScript code block containing console.log("Hello, studio"). Stay under 140 words.',
    'Release verification: reply with only STUDIO_READY.',
  ];
  const before = data.conversations.length;
  data.conversations = data.conversations.filter(
    (c) => !prompts.includes(c.messages[0]?.blocks[0]?.text),
  );
  await invoke('save_workspace', { workspace: data });
  return before - data.conversations.length;
});
await page.reload();
await expect(
  page.getByRole('heading', { name: 'Your conversations. One place to think.' }),
).toBeVisible();
await expect(page.getByText('Checking…', { exact: true })).toHaveCount(0, { timeout: 20000 });
await page.screenshot({ path: 'artifacts/release-overview.png' });
await writeFile(
  'artifacts/release-smoke.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      nativeOrigin: page.url(),
      realCodexReply: true,
      syntheticConversationsRemoved: removed,
      errors,
    },
    null,
    2,
  ),
);
expect(errors).toEqual([]);
await browser.close();
console.log(
  'Packaged app: real Codex reply, persistence, renderer and CSP passed. Synthetic chats cleaned up.',
);
