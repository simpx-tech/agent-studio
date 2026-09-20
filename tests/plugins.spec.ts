import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('plugin controls use selected transport, confirm removal, preserve drafts and fit mobile', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__,
      original = native.invoke;
    (window as any).pluginCalls = [];
    let enabled = true;
    native.invoke = async (command: string, args: any) => {
      if (command !== 'manage_plugins') return original(command, args);
      (window as any).pluginCalls.push(args);
      if (args.action.kind === 'toggle') enabled = args.action.enabled;
      return {
        plugins: [
          { id: 'fixture@local', name: 'Fixture plugin', version: '1.0', scope: 'user', enabled },
        ],
        pluginDirs: [],
        pluginUrls: [],
        skillRoots: [],
        details: ['Skills (1)', 'Hooks (0)'],
        message: 'Saved for the next reply.',
      };
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep plugin draft');
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await dialog.getByRole('button', { name: 'Plugins', exact: true }).click();
  const plugin = dialog.locator('article').filter({ hasText: 'Fixture plugin' });
  await expect(plugin).toContainText('Enabled');
  expect(
    (await page.evaluate(() => (window as any).pluginCalls)).map((c: any) => c.action.kind),
  ).toEqual(['list']);
  await plugin.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(plugin).toContainText('Disabled');
  await plugin.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(plugin).toContainText('Skills (1)');
  await plugin.getByRole('button', { name: 'Uninstall', exact: true }).click();
  expect(
    (await page.evaluate(() => (window as any).pluginCalls)).some(
      (c: any) => c.action.kind === 'uninstall',
    ),
  ).toBe(false);
  await plugin.getByRole('button', { name: 'Confirm uninstall' }).click();
  await expect(dialog).toContainText('Saved for the next reply.');
  await dialog.getByLabel('Plugin identifier', { exact: true }).fill('new@local');
  await dialog.getByRole('button', { name: 'Install plugin', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pluginCalls.some((c: any) => c.action.kind === 'install'),
      ),
    )
    .toBe(true);
  await plugin.getByRole('button', { name: 'Evaluate', exact: true }).click();
  await expect(plugin.getByRole('button', { name: 'Run evaluation', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/plugins-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep plugin draft',
  );
  const calls = await page.evaluate(() => (window as any).pluginCalls);
  expect(new Set(calls.map((c: any) => c.connectionId)).size).toBe(1);
  expect(calls.every((c: any) => c.location.path === 'C:\\Projects\\studio')).toBe(true);
});

test('Codex skill toggles refresh the inventory and preserve the composer', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__,
      original = native.invoke;
    let enabled = true;
    native.invoke = async (command: string, args: any) => {
      if (command === 'manage_plugins') {
        if (args.action.kind !== 'skill') throw new Error('Unexpected mutation');
        enabled = args.action.enabled;
        return {
          plugins: [],
          pluginDirs: [],
          pluginUrls: [],
          skillRoots: [],
          details: [],
          message: 'Saved',
        };
      }
      const result = await original(command, args);
      if (command === 'read_context')
        result.entries = [
          {
            name: 'fixture',
            path: 'C:\\skills\\fixture\\SKILL.md',
            kind: 'skills',
            scope: 'User',
            status: enabled ? 'reported' : 'disabled',
            detail: 'Fixture skill',
          },
        ];
      return result;
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Skill draft');
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await dialog.getByRole('button', { name: /^Skills/ }).click();
  await dialog.getByRole('button', { name: 'Disable skill fixture', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Enable skill fixture', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Use skill fixture', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Enable skill fixture', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Use skill fixture', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: 'artifacts/plugins-skills.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Skill draft',
  );
});
