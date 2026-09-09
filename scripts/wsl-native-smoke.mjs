// Read-only discovery through the isolated Windows QA app (CDP 9431).
// Run with the setup in docs/VERIFICATION.md. Existing chats/accounts are preserved.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9431');
try {
  const page = browser.contexts()[0].pages()[0];
  if (!page) throw new Error('Native QA page is unavailable');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost:1420/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const invoke = (command) =>
    page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
  const identity = await invoke('get_installation');
  if (identity.platform !== 'windows') throw new Error('This smoke check requires native Windows');
  const first = await invoke('discover_wsl');
  expect(first.warning).toBeNull();
  // This opt-in machine check requires at least one installed distro; unit tests cover empty lists.
  expect(first.distributions.length).toBeGreaterThan(0);
  const second = await invoke('discover_wsl');
  expect(second.distributions.map((d) => d.id)).toEqual(first.distributions.map((d) => d.id));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  for (const distro of second.distributions) {
    const row = page.locator('.environment-row').filter({ hasText: `WSL · ${distro.name}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(distro.running ? 'WSL running' : 'WSL stopped');
    await expect(row).toContainText('Managed here');
  }
  await expect(page.locator('select')).toHaveCount(0);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/wsl-discovery-native.png' });
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const profile = page.getByRole('combobox', { name: 'Login profile' });
  await profile.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: 'artifacts/wsl-picker-native.png' });
  await profile.press('Escape');
  await expect(profile).toHaveAttribute('aria-expanded', 'false');
  await expect(profile).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const saved = await invoke('load_workspace');
  for (const distro of second.distributions) {
    expect(saved.fleet.environments.filter((e) => e.id === distro.id)).toHaveLength(1);
    expect(saved.fleet.environments.find((e) => e.id === distro.id).discoveredOn).toBe(identity.id);
    expect(saved.fleet.connections.filter((c) => c.environmentId === distro.id)).toHaveLength(0);
  }
  expect(errors).toEqual([]);
  const result = {
    checkedAt: new Date().toISOString(),
    distributions: second.distributions.map(({ name, running }) => ({ name, running })),
    stableIds: true,
    savedInventory: true,
    nativeSelectCount: await page.locator('select').count(),
    pickerKeyboard: true,
    rendererErrors: errors,
  };
  await writeFile('artifacts/wsl-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close(); // Disconnect automation; leave the native app running.
}
