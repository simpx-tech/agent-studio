import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

for (const state of [
  { name: 'unfocused', focused: false, visibility: 'visible' },
  { name: 'hidden', focused: true, visibility: 'hidden' },
]) {
  test(`the selected chat still notifies when its window is ${state.name}`, async ({ page }) => {
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await chooseTestFolder(page);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Background reply');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).finishCapabilities))
      .toBe('function');
    // Headless pages emulate focus; explicitly exercise each browser state.
    await page.evaluate(({ focused, visibility }) => {
      Object.defineProperty(document, 'hasFocus', { value: () => focused });
      Object.defineProperty(document, 'visibilityState', { value: visibility });
      (window as any).finishCapabilities('complete');
    }, state);
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-notices') ?? '[]')))
      .toHaveLength(1);
  });
}

test('pending badges count idle Active chats and another chat finishing still notifies the focused app', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const count = () => page.evaluate(() => Number(localStorage.getItem('test-badge-count')));
  const notices = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('test-notices') ?? '[]'));
  const expectCount = async (n: number) => {
    await expect.poll(count).toBe(n);
    await expect(page.getByRole('status', { name: `${n} pending chats`, exact: true })).toHaveCount(
      1,
    );
  };
  await expectCount(0);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('First pending chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishCapabilities))
    .toBe('function');
  await expectCount(0);
  await page.bringToFront();
  await composer.focus();
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expectCount(1);
  expect(await notices()).toHaveLength(0);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await expectCount(1); // An unsent blank draft is not a saved chat.
  await composer.fill('Second pending chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Number(localStorage.getItem('test-run-count'))))
    .toBe(2);
  const second = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-last-request')!).conversationId,
  );
  await page.locator('.conversation-item').filter({ hasText: 'First pending chat' }).click();
  await composer.fill('Keep the first chat draft');
  await page.bringToFront();
  await expect(composer).toBeFocused();
  expect(
    await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible'),
  ).toBe(true);
  await expectCount(1);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect.poll(notices).toHaveLength(1);
  expect((await notices())[0]).toMatchObject({ kind: 'complete', conversationId: second });
  await expectCount(2);
  await expect(composer).toHaveValue('Keep the first chat draft');
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('no matching chats');
  await expectCount(2); // Search and the open chat do not redefine Pending.
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expectCount(1);
  await page.getByRole('tab', { name: /^Active/ }).click();
  await page
    .locator('.conversation-item')
    .filter({ hasText: 'Second pending chat' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expectCount(0);
  await expect(page.locator('.pending-chat-count')).toHaveCount(0);
  expect(await notices()).toHaveLength(1);
});

test('desktop defaults on, retains mute and disable, notifies for questions and completion, and skips history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Enabled on this computer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Play the Agent Studio chime')).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Play the Agent Studio chime' })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('test-notifications'))).toBeNull();
  await page.getByRole('button', { name: 'Send test notification' }).click();
  const notices = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('test-notices') ?? '[]'));
  await expect.poll(notices).toHaveLength(1);
  await page.getByLabel('Play the Agent Studio chime').uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Play the Agent Studio chime')).not.toBeChecked();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Private test question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).emitCapability))
    .toBe('function');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 'question',
        name: 'request_user_input',
        category: 'tool',
        status: 'running',
        revision: 1,
        description: 'Private text',
      },
    }),
  );
  await expect.poll(notices).toHaveLength(2);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect.poll(notices).toHaveLength(3);
  expect((await notices()).map((n: any) => n.kind)).toEqual(['test', 'attention', 'complete']);
  expect(JSON.stringify(await notices())).not.toContain('Private');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  await expect(page.getByText('Off on this computer', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Off on this computer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Play the Agent Studio chime')).not.toBeChecked();
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('desktop_notification', {
      notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` },
    }),
  );
  expect(await notices()).toHaveLength(3);
});
