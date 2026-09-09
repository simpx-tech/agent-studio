import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Opt-in integration check against the running development WebView2 only.
// No mocks: this sends small synthetic prompts using the user's CLI logins.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9427');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://localhost:1420/'));
if (!page) throw new Error('Agent Studio development webview was not found');
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await mkdir('artifacts', { recursive: true });
await page.getByRole('button', { name: 'Overview', exact: true }).click();
await expect(page.getByText('Local desktop', { exact: true })).toBeVisible();
await expect(page.getByText('Checking…', { exact: true })).toHaveCount(0, { timeout: 30000 });
await page.screenshot({ path: 'artifacts/native-overview.png' });
const results = [];
for (const provider of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Codex', 'Claude', 'Gemini']) {
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: `Chat with ${provider}`, exact: true }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('The word to remember for this test is maple. Reply only with: Noted.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(2);
  const answer = page.locator('[data-testid="message"]').last();
  try {
    await expect(answer).not.toHaveAttribute('data-status', 'running', { timeout: 90000 });
  } catch {
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect(answer).toHaveAttribute('data-status', 'cancelled', { timeout: 15000 });
  }
  const status = await answer.getAttribute('data-status');
  results.push({ provider, status, text: await answer.innerText() });
  console.log(JSON.stringify(results.at(-1)));
  if (status === 'complete') {
    await page
      .getByLabel('Message', { exact: true })
      .fill('What word did I ask you to remember? Reply with only that word.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      'data-status',
      'complete',
      { timeout: 90000 },
    );
    await expect(page.locator('.prose').last()).toContainText(/maple/i);
    console.log(`${provider}: multi-turn context verified`);
    await page.screenshot({ path: `artifacts/native-${provider.toLowerCase()}-chat.png` });
  }
}
await writeFile(
  'artifacts/native-smoke.json',
  JSON.stringify({ checkedAt: new Date().toISOString(), results, errors }, null, 2),
);
await browser.close();
