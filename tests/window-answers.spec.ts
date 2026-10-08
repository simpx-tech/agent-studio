import { expect, test, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// On 2026-10-08 the app stopped answering its window for an hour: saves, sends and the window's
// own buttons waited on calls that never returned while the page looked alive.
const hold = (page: Page, commands: string[]) =>
  page.evaluate((commands) => ((window as any).heldCommands = commands), commands);
const release = (page: Page) => page.evaluate(() => (window as any).releaseCommands());

test('a window the app stops answering says so and records the calls it waited on', async ({
  page,
}) => {
  await page.clock.install();
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const banner = page
    .getByRole('alert')
    .filter({ hasText: 'Agent Studio stopped answering this window.' });
  await hold(page, ['window_heartbeat', 'save_workspace_patch', 'save_workspace']);
  await page.clock.runFor(30_000);
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Reload window' })).toBeVisible();
  // The record outlives a reload or an app that had to be ended.
  const kept = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('agent-studio.window-stall') ?? 'null'),
  );
  expect(kept.calls.map((call: { command: string }) => call.command)).toContain('window_heartbeat');
  await release(page);
  await expect(banner).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).windowStalls?.length ?? 0)).toBe(1);
  const [stall] = await page.evaluate(() => (window as any).windowStalls);
  expect(stall.answeredAfterMs).toBeGreaterThanOrEqual(20_000);
  expect(await page.evaluate(() => localStorage.getItem('agent-studio.window-stall'))).toBeNull();
});

test('a reply starts even when the save of its message goes unanswered', async ({ page }) => {
  await page.clock.install();
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await hold(page, ['save_workspace_patch', 'save_workspace']);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Answer while saving waits');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.clock.runFor(11_000);
  await expect(page.getByRole('heading', { name: 'A clear answer' })).toBeVisible();
  // A save left unanswered says so.
  await page.clock.runFor(30_000);
  const warning = page.getByRole('alert').filter({ hasText: 'Changes are not being saved.' });
  await expect(warning).toBeVisible();
  await release(page);
  await expect(warning).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-workspace') ?? '{"conversations":[]}').conversations
            .length,
      ),
    )
    .toBe(1);
});

test('Close still closes when the app does not answer the draft save', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const original = bridge.invoke.bind(bridge);
    (window as any).closeCalled = false;
    bridge.invoke = (command: string, args: unknown) => {
      if (command === 'plugin:window|close') (window as any).closeCalled = true;
      return original(command, args);
    };
  });
  await hold(page, ['save_drafts', 'load_drafts']);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Typed before closing');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).closeCalled), { timeout: 5000 })
    .toBe(true);
});
