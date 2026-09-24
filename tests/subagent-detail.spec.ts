import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true]) {
  test(`child messages retain disclosure, draft and history ${mobile ? 'mobile' : 'desktop'}`, async ({
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
    const group = page.locator('.activity-group').last();
    await group.locator(':scope > summary').click();
    const card = group.locator('.tool-card').filter({ hasText: 'Sub-agents' });
    await card.locator(':scope > summary').click();
    const child = page.getByRole('region', { name: 'Sub-agent: Fixture reader', exact: true });
    const messages = child.locator('.agent-result').filter({ hasText: 'Messages' });
    await expect(messages).not.toHaveAttribute('open', '');
    await messages.locator('summary').click();
    await expect(messages).toContainText('Checking the marker');
    await expect(page.getByRole('region', { name: 'Sub-agent: Verifier' })).toContainText(
      'Delegated by Fixture reader',
    );
    await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
    await emit(3, true);
    await emit(2, false);
    await expect(messages).toHaveAttribute('open', '');
    await expect(messages).toContainText('Found the marker.');
    await expect(messages).toContainText('Additional child text was omitted');
    expect(await page.evaluate(() => (window as any).childExecuted)).toBeUndefined();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/subagent-detail/live-${mobile ? 'mobile' : 'desktop'}.png`,
    });
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
    await group.locator(':scope > summary').click();
    await card.locator(':scope > summary').click();
    await expect(messages).not.toHaveAttribute('open', '');
    await messages.locator('summary').click();
    await expect(messages).toContainText('Found the marker.');
    const send = group.locator('.tool-card').filter({ hasText: 'Confirm the marker' });
    await send.locator(':scope > summary').click();
    await expect(send).toContainText('Recipient');
    await expect(page.locator('.message:not(.user) .message-content > .prose').last()).toHaveText(
      'Parent final answer.',
    );
    await page.screenshot({
      path: `artifacts/subagent-detail/history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
  });
}
