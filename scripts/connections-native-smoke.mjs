// Read-only UI check of the isolated Windows QA app. No sign-in or provider prompt.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9431');
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes('1420'));
  if (!page) throw new Error('Start the isolated native QA app and Vite first.');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  const invoke = (command) =>
    page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
  if ((await invoke('plugin:app|identifier')) !== 'com.vinicius.agentstudio.federation-qa')
    throw new Error('Expected the isolated QA app.');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh connections', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  // Startup may already own the refresh. Wait for rendered results, not just an enabled button.
  await expect(page.locator('.fleet-page')).not.toContainText('Checking…', { timeout: 60_000 });
  await expect(page.locator('.fleet-page')).not.toContainText('Checking WSL…', { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Claude', exact: true })).toHaveCount(1);
  const localComputer = page
    .locator('.fleet-computer')
    .filter({ has: page.getByRole('button', { name: /^Manage computer / }) });
  await expect(localComputer.locator('.provider-group')).toHaveCount(3);
  await expect(localComputer.locator('.environment-row').first()).toContainText('Windows');
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Computer name', exact: true })).toHaveCount(0);
  const before = await invoke('load_workspace');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/connections-computers-native.png' });
  const add = page.getByRole('button', { name: 'Add account', exact: true });
  await add.click();
  const picker = page.getByRole('combobox', { name: 'Login profile' });
  const explanation = page.getByRole('note', { name: 'How this login works' });
  await expect(explanation).toContainText('same installed CLI');
  await picker.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: 'artifacts/connections-account-dialog-native.png' });
  await page.getByRole('option', { name: 'Use the existing CLI login' }).click();
  await expect(explanation).toContainText(
    'Signing out or switching that CLI’s account also changes this connection',
  );
  await page.screenshot({ path: 'artifacts/connections-existing-login-native.png' });
  await picker.click();
  await picker.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await picker.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
  await page.getByRole('button', { name: /^Manage computer / }).click();
  await page.getByRole('textbox', { name: 'Computer name', exact: true }).fill('Unsaved QA label');
  await page.screenshot({ path: 'artifacts/connections-computer-dialog-native.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
  await expect(page.getByLabel('Relay URL')).toBeVisible();
  await page.screenshot({ path: 'artifacts/connections-sync-dialog-native.png' });
  await page.getByRole('dialog').press('Escape');
  const after = await invoke('load_workspace');
  expect(after.fleet).toEqual(before.fleet);
  expect(after.conversations).toEqual(before.conversations);
  expect(errors).toEqual([]);
  const result = {
    checkedAt: new Date().toISOString(),
    singleProviderGroups: true,
    computerScopedAccounts: true,
    loginMethodExplanations: true,
    contextualForms: true,
    designSystemPickers: true,
    escapeAndFocusReturn: true,
    workspacePreserved: true,
    rendererErrors: errors,
  };
  await writeFile('artifacts/connections-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
