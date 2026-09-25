import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function send(page: Page, text: string, replies: number) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(
    replies * 2,
  );
}

test('new chats start with the agent and account last chosen, not the last one replying', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await send(page, 'Chat on the CLI login', 1);

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(agent).toHaveText(/Claude · Claude CLI login/);
  await pick(page, 'Agent', 'Claude · Second Claude');
  await send(page, 'Chat on the second account', 1);

  // Replying and changing settings in a chat on another account keeps the choice.
  await page.getByRole('button', { name: 'Chat on the CLI login', exact: true }).click();
  await expect(agent).toHaveText(/Claude · Claude CLI login/);
  await pick(page, 'Reasoning', 'High');
  await send(page, 'A follow-up on the CLI login', 2);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(agent).toHaveText(/Claude · Second Claude/);
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');

  // Reopening the app starts the new chat with it too.
  await page.reload();
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveText(/Claude · Second Claude/);

  // Choosing another account for an existing chat is a choice as well.
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Chat on the second account', exact: true }).click();
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    /Next message: Claude CLI login account/,
  );
  await page.reload();
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveText(/Claude · Claude CLI login/);
});
