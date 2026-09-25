import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const row = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });
const scratchRow = (page: Page, title: string) =>
  page.locator('.scratch-item').filter({ hasText: title });
const folderScratches = (page: Page, folder: string) =>
  page
    .locator('#conversation-panel-active .conversation-folder')
    .filter({ has: page.locator('.folder-group-toggle', { hasText: folder }) })
    .locator('.scratch-item');
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
async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
const pickFolder = (page: Page, name: string) => pick(page, 'Folder', name);

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

test('every new chat is a scratch chat that waits in its folder until it is sent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await send(page, 'Project conversation');
  const projectPlus = page.getByRole('button', {
    name: 'New conversation in studio on Desktop',
    exact: true,
  });
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await projectPlus.click();
  await expect(input(page)).toBeFocused();
  // A new chat joins the sidebar once it has something to keep.
  await expect(page.locator('.scratch-item')).toHaveCount(0);
  await input(page).fill('First idea\nwith its details');
  const first = scratchRow(page, 'First idea');
  await expect(first).toHaveAccessibleName('Unsent draft: First idea');
  await expect(first).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.page-title')).toHaveText('New conversation');

  // The folder's + starts another scratch chat instead of reopening the first.
  await projectPlus.click();
  await expect(input(page)).toHaveValue('');
  await expect(first).not.toHaveAttribute('aria-current', 'page');
  await input(page).fill('Second idea');
  await pick(page, 'Agent', 'Claude');
  await expect(folderScratches(page, 'studio')).toHaveText(['Second idea', 'First idea']);
  await page.screenshot({ path: 'artifacts/scratch-chats-browser.png', animations: 'disabled' });
  // Each keeps its own text and agent.
  await first.click();
  await expect(input(page)).toHaveValue('First idea\nwith its details');
  await expect(agent).toHaveText('Codex');
  await scratchRow(page, 'Second idea').click();
  await expect(input(page)).toHaveValue('Second idea');
  await expect(agent).toHaveText('Claude');
  // A scratch chat left empty is gone.
  await input(page).fill('');
  await expect(scratchRow(page, 'Second idea')).toHaveCount(0);
  await first.click();
  await projectPlus.click();
  await row(page, 'Project conversation').click();
  await expect(folderScratches(page, 'studio')).toHaveText(['First idea']);

  // Choosing another folder moves the scratch chat with its text.
  await first.click();
  await pickFolder(page, 'Standalone');
  await expect(folderScratches(page, 'Standalone')).toHaveText(['First idea']);
  await expect(folderScratches(page, 'studio')).toHaveCount(0);
  await expect(input(page)).toHaveValue('First idea\nwith its details');
  await expect.poll(() => savedTexts(page)).toEqual(['First idea\nwith its details']);
  // Scratch chats stay on this device.
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
    'First idea',
  );

  // A restart continues the scratch chat edited last, in its folder and with its agent.
  await page.reload();
  await expect(input(page)).toHaveValue('First idea\nwith its details');
  await expect(first).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Standalone',
  );
  await expect(agent).toHaveText('Codex');

  // `/new` carries the rest of its line into another scratch chat.
  await input(page).fill('/new Third idea');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('Third idea');
  await expect(scratchRow(page, 'Third idea')).toHaveAttribute('aria-current', 'page');
  await expect(first).toHaveCount(0);

  // Sending turns the scratch chat into the conversation.
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await expect(scratchRow(page, 'Third idea')).toHaveCount(0);
  await expect(row(page, 'Third idea')).toHaveAttribute('aria-current', 'page');
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => savedTexts(page)).toEqual([]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.at(-1).text).toBe('Third idea');
  expect(request.agent.provider).toBe('codex');
  expect(errors).toEqual([]);
});

test('scratch chats can be discarded, and earlier folder drafts become scratch chats', async ({
  page,
}) => {
  await mockDesktop(page);
  // An earlier release kept one new-chat draft per folder.
  await page.addInitScript(() => {
    if (localStorage.getItem('test-drafts')) return;
    const folder =
      '22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111/C:\\Projects\\studio';
    localStorage.setItem(
      'test-drafts',
      JSON.stringify({
        version: 1,
        drafts: [{ key: `folder:${folder}`, text: 'Saved before scratch chats', updatedAt: 1 }],
      }),
    );
  });
  await page.goto('/');
  const earlier = scratchRow(page, 'Saved before scratch chats');
  await expect(folderScratches(page, 'studio')).toHaveText(['Saved before scratch chats']);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('test-drafts')!).drafts.map(
          (d: { key: string; scratch?: { location?: { path: string } } }) => [
            d.key.split(':')[0],
            d.scratch?.location?.path,
          ],
        ),
      ),
    )
    .toEqual([['scratch', 'C:\\Projects\\studio']]);
  // The app continues it, as it did with the folder's draft.
  await expect(earlier).toHaveAttribute('aria-current', 'page');
  await expect(input(page)).toHaveValue('Saved before scratch chats');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    'C:\\Projects\\studio',
  );

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await input(page).fill('Keep typing here');
  await earlier.click({ button: 'right' });
  const menu = page.getByRole('menu', {
    name: 'Actions for Unsent draft: Saved before scratch chats',
  });
  await expect(menu.getByRole('menuitem')).toHaveText(['Discard draft']);
  await expect(menu.getByRole('menuitem', { name: 'Discard draft' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Discard draft?');
  await expect(dialog).toContainText('“Saved before scratch chats” was never sent.');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(earlier).toBeFocused();
  await earlier.press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Discard draft' }).click();
  await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await expect(input(page)).toHaveValue('Keep typing here');
  await expect(input(page)).toBeFocused();
  await expect.poll(() => savedTexts(page)).toEqual(['Keep typing here']);

  // Discarding the open scratch chat empties it where it is.
  await scratchRow(page, 'Keep typing here').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Discard draft', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.scratch-item')).toHaveCount(0);
  await expect.poll(() => savedTexts(page)).toEqual([]);
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  // Without scratch chats, a restart opens a new, empty one.
  await page.reload();
  await expect(page.locator('.template-button')).toBeEnabled();
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.scratch-item')).toHaveCount(0);
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
