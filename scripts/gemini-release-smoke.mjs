import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9428');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://tauri.localhost/'));
if (!page) throw new Error('Packaged Agent Studio app not found');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const marker = `Gemini integration check ${crypto.randomUUID()}`;
await page.getByRole('button', { name: 'Connections', exact: true }).click();
const card = page
  .locator('.connection-card')
  .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
await expect(card.locator('.connection-badge')).toHaveText('Connected', { timeout: 30000 });
await expect(card).toContainText('Signed in to Google through Antigravity CLI');
await expect(card.locator('code').nth(1)).toHaveText('agy');
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await page.getByRole('button', { name: 'Chat with Gemini', exact: true }).click();
await page
  .getByLabel('Message', { exact: true })
  .fill(`${marker}. Remember the word maple. Reply only with Noted.`);
await page.getByRole('button', { name: 'Send message' }).click();
await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
  'data-status',
  'complete',
  { timeout: 90000 },
);
await expect(page.locator('.prose').last()).toContainText('Noted');
await page
  .getByLabel('Message', { exact: true })
  .fill('What word did I ask you to remember? Reply only with that word.');
await page.getByRole('button', { name: 'Send message' }).click();
await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
  'data-status',
  'complete',
  { timeout: 90000 },
);
await expect(page.locator('.prose').last()).toContainText(/maple/i);
await page.screenshot({ path: 'artifacts/gemini-release-chat.png' });
await page.getByRole('button', { name: 'Connections', exact: true }).click();
await expect(card.locator('.connection-badge')).toHaveText('Connected');
// Remove just this run's unique synthetic conversation; preserve user data.
await expect
  .poll(() =>
    page.evaluate(async (marker) => {
      const workspace = await window.__TAURI_INTERNALS__.invoke('load_workspace', {});
      return workspace.conversations.some(
        (c) =>
          c.messages[0]?.blocks[0]?.text.startsWith(marker) &&
          c.messages.length === 4 &&
          c.messages[3].status === 'complete',
      );
    }, marker),
  )
  .toBe(true);
await page.evaluate(async (marker) => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const workspace = await invoke('load_workspace', {});
  workspace.conversations = workspace.conversations.filter(
    (c) => !c.messages[0]?.blocks[0]?.text.startsWith(marker),
  );
  await invoke('save_workspace', { workspace });
}, marker);
await page.reload();
expect(errors).toEqual([]);
await writeFile(
  'artifacts/gemini-release-smoke.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: page.url(),
      authenticatedReply: true,
      multiTurn: true,
      connectedStatus: true,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
console.log(
  'Packaged app: Gemini authentication, real replies, multi-turn context and Connected status passed.',
);
