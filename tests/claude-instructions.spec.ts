import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const lastRequest = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));

async function send(page: Page, text: string) {
  const messages = page.locator('.message');
  const before = await messages.count();
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(messages).toHaveCount(before + 2);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: 'Claude chat instructions', exact: true });
}

test('Claude chat instructions start from the default, save, reset, turn off, and reach only Claude chats', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /^Codex/ })
    .first()
    .click();
  await send(page, 'Codex reply');
  expect(await lastRequest(page)).not.toHaveProperty('claudeInstructions');

  let section = await openSettings(page);
  const field = section.getByLabel('Claude chat instructions', { exact: true });
  const save = section.getByRole('button', { name: 'Save Claude instructions', exact: true });
  const reset = section.getByRole('button', { name: 'Reset to default', exact: true });
  await expect(field).toHaveValue(/run_in_background/);
  const defaultText = await field.inputValue();
  await expect(section.getByText(/^Default instructions/)).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(reset).toBeDisabled();
  await field.fill('Run tests in the foreground.\nKeep "servers" in the background.');
  await expect(section.getByText(/Custom instructions · .* Unsaved changes/)).toBeVisible();
  await save.click();
  await expect(section.getByRole('status')).toHaveText('Saved for the next Claude reply.');
  await expect(save).toBeDisabled();

  await page.reload();
  section = await openSettings(page);
  await expect(field).toHaveValue(
    'Run tests in the foreground.\nKeep "servers" in the background.',
  );
  await section.screenshot({ path: 'artifacts/claude-instructions/settings.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await field.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await section.screenshot({ path: 'artifacts/claude-instructions/mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /^Claude/ })
    .first()
    .click();
  await send(page, 'Claude reply');
  expect((await lastRequest(page)).claudeInstructions).toBe(
    'Run tests in the foreground.\nKeep "servers" in the background.',
  );
  // Conversation instructions stay separate from the workspace-wide text.
  expect((await lastRequest(page)).agent.instructions).toBe('');

  section = await openSettings(page);
  await reset.click();
  await expect(section.getByRole('status')).toHaveText('Restored the default instructions.');
  await expect(field).toHaveValue(defaultText);
  await expect(reset).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await send(page, 'Default reply');
  expect((await lastRequest(page)).claudeInstructions).toBe(defaultText);

  section = await openSettings(page);
  await field.fill('');
  await expect(section.getByText(/^Off: Claude chats get no added instructions/)).toBeVisible();
  await save.click();
  await expect(section.getByRole('status')).toHaveText('Saved for the next Claude reply.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await send(page, 'Plain reply');
  expect(await lastRequest(page)).not.toHaveProperty('claudeInstructions');
});
