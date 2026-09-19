import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('MCP sign-in waits for confirmation, cancels on close, preserves drafts and confirms sign-out', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__,
      original = native.invoke;
    (window as any).mcpCalls = [];
    native.invoke = async (command: string, args: any) => {
      if (command !== 'manage_mcp') return original(command, args);
      (window as any).mcpCalls.push(args);
      if (args.action.kind === 'authenticate' || args.action.kind === 'poll')
        return {
          status: 'pending',
          operationId: '5f3605d1-7c60-4ce7-aeb5-1519a5a550ad',
          authorizationUrl: 'https://example.com/oauth?state=synthetic',
          callbackAllowed: true,
          servers: [],
          message: 'Waiting for CLI confirmation.',
        };
      return { status: 'complete', servers: [], message: 'CLI confirmed the change.' };
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await dialog.getByRole('button', { name: /^MCPs/ }).click();
  const server = dialog
    .locator('article')
    .filter({ has: page.getByText('docs-mcp', { exact: true }) });
  await expect(server).toBeVisible();
  expect(await page.evaluate(() => (window as any).mcpCalls)).toEqual([]);
  await server.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Open sign-in', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Waiting for CLI confirmation');
  await expect(dialog.getByRole('button', { name: 'Add server', exact: true })).toBeDisabled();
  await dialog.getByText('Browser callback could not reach this computer?').click();
  await expect(dialog.getByLabel('Paste the full redirect URL')).toHaveAttribute(
    'type',
    'password',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mcp-oauth-mobile.png' });
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).mcpCalls.some((c: any) => c.action.kind === 'cancel')),
    )
    .toBe(true);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep my draft',
  );
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await dialog.getByRole('button', { name: /^MCPs/ }).click();
  await server.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).mcpCalls.some((c: any) => c.action.kind === 'logout'),
    ),
  ).toBe(false);
  await server.getByRole('button', { name: 'Confirm sign out' }).click();
  await expect(dialog).toContainText('CLI confirmed the change.');
  await dialog.getByRole('button', { name: 'Add server', exact: true }).click();
  await dialog.getByLabel('Server name', { exact: true }).fill('new-docs');
  await dialog.getByLabel('Server URL', { exact: true }).fill('https://example.com/mcp');
  await dialog.getByRole('button', { name: 'Save server', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).mcpCalls.some((c: any) => c.action.kind === 'add')),
    )
    .toBe(true);
  const calls = await page.evaluate(() => (window as any).mcpCalls);
  expect(new Set(calls.map((c: any) => c.connectionId)).size).toBe(1);
  expect(calls.every((c: any) => c.location.path === 'C:\\Projects\\studio')).toBe(true);
  await page.screenshot({ path: 'artifacts/mcp-management-browser.png' });
});
