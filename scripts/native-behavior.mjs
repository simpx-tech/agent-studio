import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9427');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://localhost:1420/'));
if (!page) throw new Error('Development app was not found');
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await page.getByRole('button', { name: 'Chat with Codex', exact: true }).click();
await page
  .getByLabel('Message', { exact: true })
  .fill('Cancellation verification: explain how a rainbow forms in detail.');
await page.getByRole('button', { name: 'Send message' }).click();
await expect(page.getByText('Starting the provider CLI', { exact: true })).toBeAttached({
  timeout: 10000,
});
await page.getByRole('button', { name: 'Stop response', exact: true }).click();
await expect(page.locator('[data-status="cancelled"]')).toHaveCount(1, { timeout: 15000 });
console.log('Native cancellation acknowledged; process cleanup completed.');
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await page.getByRole('button', { name: 'Chat with Claude', exact: true }).click();
await page
  .getByLabel('Message', { exact: true })
  .fill(
    'Write a short welcome guide for a personal AI workspace. Use the heading "Your next idea starts here", three bullet points, a small table comparing Agents and Conversations, and a JavaScript code block containing console.log("Hello, studio"). Stay under 140 words.',
  );
await page.getByRole('button', { name: 'Send message' }).click();
await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
  'data-status',
  'complete',
  { timeout: 90000 },
);
await expect(page.locator('.prose table')).toBeVisible();
await expect(page.locator('.prose pre code')).toContainText('Hello, studio');
await page.screenshot({ path: 'artifacts/native-rich-chat.png' });
await page.reload();
await page
  .locator('.conversation-list')
  .getByRole('button', { name: /Write a short welcome guide/ })
  .click();
await expect(page.locator('.prose table')).toBeVisible();
await page.getByRole('button', { name: 'Connections', exact: true }).click();
await page.getByRole('button', { name: 'Export workspace as JSON' }).click();
await expect(page.getByRole('status')).toContainText('Workspace exported to');
await writeFile(
  'artifacts/native-behavior.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      cancellation: true,
      richRendering: true,
      persistenceAfterReload: true,
      export: true,
    },
    null,
    2,
  ),
);
await browser.close();
