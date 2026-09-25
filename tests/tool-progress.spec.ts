import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true]) {
  test(`safe tool progress stays visible and survives history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Run a long check');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (revision: number, elapsedMs: number, kind?: string, status = 'running') =>
      page.evaluate(
        (data) => {
          (window as any).emitCapability({
            kind: 'tool',
            tool: {
              id: 'command',
              name: 'Run command',
              category: 'tool',
              operation: 'command',
              commandRun: true,
              status: data.status,
              revision: data.revision,
              elapsedMs: data.elapsedMs,
              facts: [],
              agents: [],
              sources: [],
              ...(data.kind
                ? {
                    progress: {
                      kind: data.kind,
                      atElapsedMs: 12000,
                      message: 'PRIVATE_MESSAGE',
                      stdin: 'PRIVATE_INPUT',
                    },
                  }
                : {}),
              delta: 'PRIVATE_OUTPUT',
            },
          });
        },
        { revision, elapsedMs, kind, status },
      );
    await emit(1, 0);
    // The running command has a row of its own showing its time and latest progress signal.
    const row = page.locator('.live-row').last();
    await expect(row).not.toHaveAttribute('open', '');
    await expect(row.locator(':scope > summary')).toContainText('Running');
    await emit(2, 12000, 'output');
    await expect(row.locator(':scope > summary')).toContainText('Output received');
    await expect(row.locator(':scope > summary')).toContainText('12s');
    await row.locator(':scope > summary').click();
    await expect(row.locator('.tool-progress')).toHaveText('Output received at 12s');
    await page.getByLabel('Message', { exact: true }).fill('Preserve this draft');
    await emit(4, 14000, 'terminal');
    await emit(3, 13000, 'heartbeat');
    await expect(row).toHaveAttribute('open', '');
    await expect(row.locator('.tool-progress')).toHaveText('Terminal interaction at 12s');
    await expect(row.locator(':scope > summary')).toContainText('14s');
    await expect(page.locator('body')).not.toContainText('PRIVATE_');
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/tool-progress/live-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await emit(5, 15000, 'terminal', 'complete');
    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Checks complete.' });
      (window as any).finishCapabilities('complete');
    });
    await page.getByLabel('Work history', { exact: true }).click();
    const group = page.locator('.activity-group').last();
    const card = group.locator('.tool-card');
    await group.locator(':scope > summary').click();
    await card.locator('summary').click();
    await expect(card.locator('summary')).toContainText('15s');
    await expect(card.locator('summary')).toContainText('Completed');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Preserve this draft');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
      'PRIVATE_',
    );
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await page.getByLabel('Work history', { exact: true }).click();
    await group.locator(':scope > summary').click();
    await card.locator('summary').click();
    await expect(card.locator('summary')).toContainText('15s');
    await expect(card.locator('.tool-progress')).toHaveText('Terminal interaction at 12s');
    await page.screenshot({
      path: `artifacts/tool-progress/history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
  });
}

test('stopped replies freeze last observed time and retain an unconfirmed outcome', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Start work');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 'unfinished',
        category: 'tool',
        name: 'Connected tool',
        revision: 1,
        status: 'running',
        elapsedMs: 9000,
        progress: { kind: 'heartbeat', atElapsedMs: 8000 },
        sources: [],
        agents: [],
      },
    });
    (window as any).finishCapabilities('cancelled');
  });
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').last().click();
  const card = page.locator('.tool-card').last();
  await expect(card).toContainText('9s');
  await expect(card).toContainText('Stopped');
  await expect(page.locator('.group-progress')).toHaveCount(0);
});
