import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function prepare(page: Page) {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const state = window as any,
      native = state.__TAURI_INTERNALS__;
    const invoke = native.invoke,
      transform = native.transformCallback;
    const callbacks = new Map<number, (value: unknown) => void>();
    let listener = 0;
    const epoch = crypto.randomUUID();
    const revisions: Record<string, number> = {};
    const accountRevisions: Record<string, number> = {};
    state.redemptions = [];
    native.transformCallback = (fn: (value: unknown) => void) => {
      const id = transform(fn);
      callbacks.set(id, fn);
      return id;
    };
    native.invoke = async (command: string, args: any) => {
      if (command === 'plugin:event|listen' && args.event === 'studio-account-update')
        listener = args.handler;
      if (command === 'live_account_updates') return [];
      if (command === 'detect_connection' && args.provider === 'codex' && state.holdAuth)
        await new Promise<void>((resolve) => {
          state.releaseAuth = resolve;
        });
      if (command === 'manage_account') {
        if (args.input.action === 'workspaceMessages')
          return {
            featureEnabled: true,
            messages: [
              {
                messageId: 'notice',
                messageBody:
                  '<script>window.noticeExecuted=true</script> Workspace maintenance at 5pm.',
              },
            ],
          };
        state.redemptions.push(args);
        if (state.redemptions.length === 1)
          throw Error('Reset outcome is unconfirmed. Retry the same attempt.');
        state.redeemed = true;
        return { outcome: 'alreadyRedeemed' };
      }
      const result = await invoke(command, args);
      if (command === 'read_usage' && args.provider === 'codex') {
        result.windows = [
          {
            id: 'codex-primary',
            label: 'Weekly',
            usedPercent: state.redeemed ? 20 : 95,
            windowMinutes: 10080,
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
            model: null,
            bucket: 'codex',
          },
        ];
        result.credits = {
          kind: 'codex',
          balance: 42.125,
          hasCredits: true,
          unlimited: false,
          resetCredits: state.redeemed ? 1 : 2,
        };
        if (state.holdUsage)
          await new Promise<void>((resolve) => {
            state.releaseUsage = resolve;
          });
      }
      return result;
    };
    state.pushUsage = (
      provider: string,
      percent: number,
      options: { revision?: number; foreign?: boolean; account?: boolean } = {},
    ) => {
      const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
      const connection = workspace.fleet.connections.find((c: any) =>
        workspace.fleet.accounts.some((a: any) => a.id === c.accountId && a.provider === provider),
      );
      const revision = options.revision ?? (revisions[provider] ?? 0) + 1;
      revisions[provider] = Math.max(revisions[provider] ?? 0, revision);
      if (options.account) accountRevisions[provider] = revision;
      const now = Math.floor(Date.now() / 1000);
      callbacks.get(listener)!({
        event: 'studio-account-update',
        id: 1,
        payload: {
          connectionId: options.foreign ? crypto.randomUUID() : connection.id,
          epoch,
          revision,
          accountChanged: accountRevisions[provider] ?? 0,
          authMode: accountRevisions[provider] ? 'chatgpt' : null,
          planType: provider === 'codex' ? 'pro' : null,
          creditsCheckedAt: null,
          limitStatus:
            provider === 'claude'
              ? {
                  status: 'allowed_warning',
                  limitType: 'seven_day',
                  resetsAt: now + 3600,
                  usingOverage: false,
                  checkedAt: now,
                }
              : null,
          snapshot: {
            provider,
            checkedAt: now,
            windows: options.account
              ? []
              : [
                  {
                    id: provider === 'codex' ? 'codex-primary' : 'seven_day',
                    label: 'Weekly',
                    usedPercent: percent,
                    windowMinutes: 10080,
                    resetsAt: now + 3600,
                    model: null,
                    bucket: provider,
                    checkedAt: now,
                  },
                ],
            credits: null,
            context: null,
            detail: 'Reported live',
          },
        },
      });
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
}

test('an account change closes a pending reset confirmation and rechecks the selected connection', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const account = page.getByRole('region', { name: 'Usage for Codex CLI login', exact: true });
  await expect(account).toContainText('95% used');
  await account.getByRole('button', { name: 'Use a reset credit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Use one reset credit?' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).holdAuth = true;
    (window as any).pushUsage('codex', 0, { account: true });
  });
  await expect(page.getByRole('dialog', { name: 'Use one reset credit?' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseAuth)).toBe('function');
  await page.evaluate(() => {
    (window as any).pushUsage('codex', 96);
    (window as any).holdAuth = false;
    (window as any).releaseAuth();
  });
  await expect(account).toContainText('95% used');
  expect(await page.evaluate(() => (window as any).redemptions)).toHaveLength(0);
});

test('native notifications update both panels immediately without polling or losing drafts', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(page.locator('.usage-strip')).toContainText('95%');
  await page.getByLabel('Message', { exact: true }).fill('Preserve this draft');
  const reads = await page.evaluate(() => localStorage.getItem('test-usage-requests'));
  await page.evaluate(() => (window as any).pushUsage('codex', 97));
  await expect(page.locator('.usage-strip')).toContainText('97%');
  expect(await page.evaluate(() => localStorage.getItem('test-usage-requests'))).toBe(reads);
  await page.evaluate(() => {
    (window as any).pushUsage('codex', 1, { revision: 1 });
    (window as any).pushUsage('codex', 2, { foreign: true });
  });
  await expect(page.locator('.usage-strip')).toContainText('97%');
  await page.locator('.context-chip').click();
  await expect(page.locator('#usage-details')).toContainText('42.12 credits');
  await expect(page.locator('#usage-details')).toContainText('Workspace maintenance at 5pm.');
  expect(await page.evaluate(() => (window as any).noticeExecuted)).toBeUndefined();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const account = page.getByRole('region', { name: 'Usage for Codex CLI login', exact: true });
  await expect(account).toContainText('95% used');
  await page.evaluate(() => (window as any).pushUsage('codex', 98));
  await expect(account).toContainText('98% used');
  await page.evaluate(() => (window as any).pushUsage('claude', 88));
  await expect(
    page.getByRole('region', { name: 'Usage for Claude CLI login', exact: true }),
  ).toContainText('approaching a limit');
  await page.screenshot({ path: 'artifacts/live-usage/connections.png' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Preserve this draft');
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
    'Workspace maintenance',
  );
});

test('late polling cannot overwrite a newer push and reset redemption requires confirmation and stable retry identity', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const account = page.getByRole('region', { name: 'Usage for Codex CLI login', exact: true });
  await expect(account).toContainText('95% used');
  await page.evaluate(() => {
    (window as any).holdUsage = true;
  });
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseUsage))
    .toBe('function');
  await page.evaluate(() => {
    (window as any).pushUsage('codex', 99);
    (window as any).holdUsage = false;
    (window as any).releaseUsage();
  });
  await expect(account).toContainText('99% used');
  await account.getByRole('button', { name: 'Use a reset credit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Use one reset credit?' });
  await expect(dialog).toContainText('Codex CLI login');
  expect(await page.evaluate(() => (window as any).redemptions.length)).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).redemptions.length)).toBe(0);
  await account.getByRole('button', { name: 'Use a reset credit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use one credit', exact: true }).click();
  await expect(account).toContainText('Reset outcome is unconfirmed');
  await account.getByRole('button', { name: 'Retry usage reset', exact: true }).click();
  await dialog.getByRole('button', { name: 'Retry same reset', exact: true }).click();
  await expect(account).toContainText('20% used');
  const attempts = await page.evaluate(() => (window as any).redemptions);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  await account.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/live-usage/reset-mobile.png' });
});
