import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const row = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });
const savedTexts = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(localStorage.getItem('test-drafts') ?? 'null')?.drafts ?? [])
      .map((draft: { text: string }) => draft.text)
      .sort(),
  );
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
}
async function pickFolder(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('each chat keeps its unsent draft across switching, restarts and sending', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await send(page, 'First chat');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await send(page, 'Second chat');
  await row(page, 'First chat').click();
  await expect(input(page)).toHaveValue('');
  await input(page).fill('Unsent reply for the first chat');
  await row(page, 'Second chat').click();
  await expect(input(page)).toHaveValue('');
  await input(page).fill('Unsent reply for the second chat');
  await row(page, 'First chat').click();
  await expect(input(page)).toHaveValue('Unsent reply for the first chat');
  // Reopening the chat that is already open keeps its text.
  await row(page, 'First chat').click();
  await expect(input(page)).toHaveValue('Unsent reply for the first chat');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(input(page)).toHaveValue('Unsent reply for the first chat');
  await expect
    .poll(() => savedTexts(page))
    .toEqual(['Unsent reply for the first chat', 'Unsent reply for the second chat']);
  // Drafts belong to this device: never part of the portable workspace.
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
    'Unsent reply',
  );

  await page.reload();
  const history = page.getByRole('tab', { name: /^History/ });
  await history.click();
  await row(page, 'Second chat').click();
  await expect(input(page)).toHaveValue('Unsent reply for the second chat');
  await row(page, 'First chat').click();
  await expect(input(page)).toHaveValue('Unsent reply for the first chat');
  // Opening and typing leave a History chat in History; sending restores it.
  await expect(history).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await expect(input(page)).toHaveValue('');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.at(-1).text).toBe('Unsent reply for the first chat');
  await expect.poll(() => savedTexts(page)).toEqual(['Unsent reply for the second chat']);

  await page.reload();
  await history.click();
  await row(page, 'First chat').click();
  await expect(input(page)).toHaveValue('');
  await row(page, 'Second chat').click();
  await expect(input(page)).toHaveValue('Unsent reply for the second chat');
  // Deleting a conversation deletes its draft.
  await row(page, 'First chat').click();
  await row(page, 'Second chat').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(row(page, 'Second chat')).toHaveCount(0);
  await expect.poll(() => savedTexts(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('new chats keep separate drafts per folder and Standalone location', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await send(page, 'Project conversation');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pickFolder(page, 'Standalone');
  await send(page, 'General conversation');
  const projectPlus = page.getByRole('button', {
    name: 'New conversation in studio on Desktop',
    exact: true,
  });
  const standalonePlus = page.getByRole('button', {
    name: 'New standalone conversation on Desktop',
    exact: true,
  });
  await projectPlus.click();
  await expect(input(page)).toHaveValue('');
  await input(page).fill('Project idea');
  await standalonePlus.click();
  await expect(input(page)).toHaveValue('');
  await input(page).fill('Standalone idea');
  await projectPlus.click();
  await expect(input(page)).toHaveValue('Project idea');
  await expect(input(page)).toBeFocused();
  await standalonePlus.click();
  await expect(input(page)).toHaveValue('Standalone idea');
  await row(page, 'Project conversation').click();
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => savedTexts(page)).toEqual(['Project idea', 'Standalone idea']);

  // After a restart, the startup draft uses the most recent location, here Standalone.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Standalone',
  );
  await expect(input(page)).toHaveValue('Standalone idea');
  await page.getByRole('tab', { name: /^History/ }).click();
  await projectPlus.click();
  await expect(input(page)).toHaveValue('Project idea');

  // Changing a new chat's folder carries its text; a draft saved there stays first.
  await pickFolder(page, 'Standalone');
  await expect(input(page)).toHaveValue('Standalone idea\n\nProject idea');
  await page.getByRole('tab', { name: /^History/ }).click();
  await projectPlus.click();
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => savedTexts(page)).toEqual(['Standalone idea\n\nProject idea']);
  await page.getByRole('tab', { name: /^History/ }).click();
  await standalonePlus.click();
  await expect(input(page)).toHaveValue('Standalone idea\n\nProject idea');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => savedTexts(page)).toEqual([]);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(input(page)).toHaveValue('');
});

test('closing the window saves a draft typed a moment earlier', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const original = bridge.invoke.bind(bridge);
    (window as any).commandOrder = [];
    bridge.invoke = (command: string, args: unknown) => {
      if (['save_drafts', 'plugin:window|close'].includes(command))
        (window as any).commandOrder.push(command);
      return original(command, args);
    };
  });
  await input(page).fill('Typed right before closing');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).commandOrder))
    .toEqual(['save_drafts', 'plugin:window|close']);
  expect(await savedTexts(page)).toEqual(['Typed right before closing']);
});

test('a restored draft keeps its selected mention for the same chat', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await send(page, 'Codex chat');
  await input(page).fill('Check @src');
  await expect(page.getByRole('option', { name: 'src/my file.ts', exact: true })).toBeVisible();
  await input(page).press('Tab');
  await expect(input(page)).toHaveValue('Check @"src/my file.ts" ');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await row(page, 'Codex chat').click();
  await expect(input(page)).toHaveValue('Check @"src/my file.ts" ');
  await expect.poll(() => savedTexts(page)).toEqual(['Check @"src/my file.ts" ']);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await row(page, 'Codex chat').click();
  await expect(input(page)).toHaveValue('Check @"src/my file.ts" ');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.at(-1).mentions.map((m: { path: string }) => m.path)).toEqual([
    'C:\\Projects\\studio/src/my file.ts',
  ]);
});
