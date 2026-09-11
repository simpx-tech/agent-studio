import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('desktop defaults on, retains mute and disable, notifies for questions and completion, and skips history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByText('Enabled on this computer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Play the Agent Studio chime')).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('test-notifications'))).toBeNull();
  await page.getByRole('button', { name: 'Send test notification' }).click();
  const notices = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('test-notices') ?? '[]'));
  await expect.poll(notices).toHaveLength(1);
  await page.getByLabel('Play the Agent Studio chime').uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Play the Agent Studio chime')).not.toBeChecked();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('Private test question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).emitCapability))
    .toBe('function');
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
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  await expect(page.getByText('Off on this computer', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByText('Off on this computer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Play the Agent Studio chime')).not.toBeChecked();
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('desktop_notification', {
      notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` },
    }),
  );
  expect(await notices()).toHaveLength(3);
});
