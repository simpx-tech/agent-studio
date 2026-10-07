import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true]) {
  test(`child messages open in the sub-agent's panel and keep the draft and history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Delegate a fixture');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (revision: number, complete: boolean) =>
      page.evaluate(
        ({ revision, complete }) => {
          (window as any).emitCapability({
            kind: 'tool',
            tool: {
              id: 'children',
              revision,
              name: 'Sub-agents',
              category: 'agent',
              status: complete ? 'complete' : 'running',
              sources: [],
              agents: [
                {
                  id: 'reader',
                  name: 'Fixture reader',
                  status: complete ? 'complete' : 'running',
                  task: 'Inspect fixture',
                  messages: [
                    {
                      id: 'one',
                      text: 'Inspecting <script>window.childExecuted = true</script>',
                      complete: true,
                    },
                    {
                      id: 'two',
                      text: complete ? 'Found the marker.' : 'Checking the marker…',
                      complete,
                    },
                  ],
                  messagesTruncated: complete,
                  result: complete ? 'Child result' : undefined,
                },
                { id: 'nested', name: 'Verifier', parentId: 'reader', status: 'complete' },
              ],
            },
          });
          (window as any).emitCapability({
            kind: 'tool',
            tool: {
              id: 'send',
              revision,
              name: 'Message agent',
              category: 'tool',
              operation: 'sendMessage',
              status: 'complete',
              facts: [{ label: 'Recipient', value: 'Fixture reader' }],
              detail: 'Confirm the marker',
              sources: [],
              agents: [],
            },
          });
        },
        { revision, complete },
      );
    await emit(1, false);
    // A running sub-agent has a row of its own, which lists the sub-agents it runs.
    const row = page.locator('.live-row[data-category="agent"]');
    await expect(row.locator(':scope > summary')).toContainText('Working with');
    await row.locator(':scope > summary').click();
    await expect(row.locator('.subagent-row', { hasText: 'Verifier' })).toContainText(
      'Delegated by Fixture reader',
    );
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByLabel('Message', { exact: true }).fill('Keep my draft');

    // Its row opens what it was asked and what it said so far beside the chat.
    await row.locator('.subagent-row', { hasText: 'Inspect fixture' }).click();
    const child = page.getByRole('dialog', { name: 'Fixture reader' });
    await expect(child.getByRole('region', { name: 'Task' })).toHaveText(/Inspect fixture/);
    await expect(child).toContainText('Checking the marker');
    await emit(3, true);
    await emit(2, false);
    await expect(child.locator('header')).toContainText('Completed');
    await expect(child).toContainText('Found the marker.');
    await expect(child).not.toContainText('Checking the marker');
    await expect(child).toContainText('Older versions kept only 16 of its messages.');
    await expect(child.getByRole('region', { name: 'Result' })).toHaveText('Child result');
    // Child text is sanitized Markdown.
    await expect(child).toContainText('Inspecting');
    await expect(child.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).childExecuted)).toBeUndefined();
    await page.screenshot({
      path: `artifacts/subagent-detail/live-${mobile ? 'mobile' : 'desktop'}.png`,
    });

    // A sub-agent it delegated to opens in its place.
    await child.locator('.activity-group > summary').click();
    await child.getByRole('button', { name: /Verifier/ }).click();
    const nested = page.getByRole('dialog', { name: 'Verifier' });
    await expect(nested.locator('header')).toContainText('Delegated by Fixture reader');
    await nested.getByRole('button', { name: 'Close sub-agent' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Parent final answer.' });
      (window as any).finishCapabilities('complete');
    });
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await page.getByLabel('Work history', { exact: true }).click();
    const group = page.locator('.activity-group').last();
    await group.locator(':scope > summary').click();
    const send = group.locator('.tool-card').filter({ hasText: 'Confirm the marker' });
    await send.locator(':scope > summary').click();
    await expect(send).toContainText('Recipient');
    await group.locator('.subagent-row', { hasText: 'Inspect fixture' }).click();
    await expect(child).toContainText('Found the marker.');
    await expect(child.getByRole('region', { name: 'Result' })).toHaveText('Child result');
    await page.screenshot({
      path: `artifacts/subagent-detail/history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await child.getByRole('button', { name: 'Close sub-agent' }).click();
    await expect(page.locator('.message:not(.user) .message-content > .prose').last()).toHaveText(
      'Parent final answer.',
    );
  });
}
