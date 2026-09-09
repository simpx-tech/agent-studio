// Read-only native regression check: no model prompts, login changes, or mocks.
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
const snapshot = () =>
  page.evaluate(async () => {
    const data = await window.__TAURI_INTERNALS__.invoke('load_workspace', {});
    return JSON.stringify(data);
  });
const before = await snapshot();
const openConnections = () =>
  page.getByRole('button', { name: 'Connections', exact: true }).click();
const card = page
  .locator('.connection-card')
  .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
await openConnections();
await expect(card.locator('.connection-badge')).toHaveText('Connected', { timeout: 30000 });
await expect(card).toContainText('Signed in to Google through Antigravity CLI');
await page.getByRole('button', { name: 'Refresh connections' }).click();
await expect(page.getByRole('button', { name: 'Refresh connections' })).toBeEnabled({
  timeout: 30000,
});
await expect(card.locator('.connection-badge')).toHaveText('Connected');
await page.reload();
await openConnections();
await expect(card.locator('.connection-badge')).toHaveText('Connected', { timeout: 30000 });
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await expect(page.getByRole('button', { name: 'Checking…' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Refresh connections' })).toBeEnabled({
  timeout: 30000,
});
await expect(card.locator('.connection-badge')).toHaveText('Connected');
expect(await snapshot()).toEqual(before);
await card.scrollIntoViewIfNeeded();
await page.screenshot({ path: 'artifacts/login-status-connections.png' });
expect(errors).toEqual([]);
await writeFile(
  'artifacts/login-status-smoke.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin: page.url(),
      connectedBeforeChat: true,
      manualRefresh: true,
      reload: true,
      focusRefresh: true,
      workspaceUnchanged: true,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
console.log(
  'Google Connected status verified before any chat, after refresh, reload and focus. Workspace unchanged.',
);
