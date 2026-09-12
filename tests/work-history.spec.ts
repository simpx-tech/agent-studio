import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true])
  test(`progress-only work history stays above the answer ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Compare the options');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    await page.evaluate(() => {
      const emit = (window as any).emitCapability;
      emit({ kind: 'activity', text: 'Starting the provider CLI' });
      emit({ kind: 'activity', text: 'Connected to Claude' });
    });
    await expect(page.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const emit = (window as any).emitCapability;
      emit({ kind: 'progress', id: 'first', revision: 1, text: 'I will compare the options.' });
      emit({
        kind: 'progress',
        id: 'second',
        revision: 1,
        text: 'The second option fits your requirements.',
      });
      emit({ kind: 'text', text: 'Choose the second option.' });
      (window as any).finishCapabilities('complete');
    });
    const reply = page.locator('.message[data-status="complete"]').last();
    const history = reply.locator('.activity-summary');
    const toggle = reply.getByLabel('Work history', { exact: true });
    const draft = page.getByLabel('Message', { exact: true });
    await draft.fill('Keep this next message');
    await expect(toggle).toContainText('2 progress updates');
    await expect(toggle).not.toContainText('tool calls');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(history).toHaveCSS('border-bottom-width', '0px');
    await expect(reply.locator('.message-heading + .tool-activity + .prose')).toHaveText(
      'Choose the second option.',
    );
    await expect(history.locator('.progress-message').first()).not.toBeVisible();
    await page.screenshot({
      path: `artifacts/work-history-collapsed-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(history.locator('.progress-message')).toHaveText([
      'I will compare the options.',
      'The second option fits your requirements.',
    ]);
    await expect(history.locator('.activity-filters')).toHaveCount(0);
    await expect(history).toHaveCSS('border-bottom-width', '1px');
    await expect(history).toHaveCSS('border-bottom-style', 'solid');
    await expect(history.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(history.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await expect(draft).toHaveValue('Keep this next message');
    expect(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/work-history-expanded-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(history).toHaveCSS('border-bottom-width', '0px');
    await expect(draft).toHaveValue('Keep this next message');
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
    await toggle.click();
    await expect(history.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(history.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await expect(history.locator('.progress-message')).toHaveCount(2);
    await expect(history).toHaveCSS('border-bottom-width', '1px');
  });
