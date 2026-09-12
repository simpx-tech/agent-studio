import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true])
  test(`tool batches stay compact while running and in saved history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Check the source and run tests');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const tool = (id: string, operation: string, name: string, extra = {}) => ({
      kind: 'tool',
      tool: {
        id,
        operation,
        name,
        category: 'tool',
        revision: 1,
        status: 'complete',
        sources: [],
        agents: [],
        ...extra,
      },
    });
    await emit({
      kind: 'progress',
      id: 'before',
      revision: 1,
      text: 'I will check the source files.',
    });
    await emit(tool('read1', 'read', 'Read', { path: '/fixture/app.ts' }));
    await emit(tool('read2', 'read', 'Read', { path: '/fixture/menu.ts' }));
    const groups = page.locator('.activity-group');
    await expect(groups).toHaveCount(1);
    await expect(groups.first().locator(':scope > summary')).toHaveText('Read files');
    await expect(groups.first()).not.toHaveAttribute('open', '');
    await expect(page.locator('.tool-card').first()).not.toBeVisible();
    await groups.first().locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(groups.first().locator('.tool-card')).toHaveCount(2);
    await expect(groups.first().locator('.tool-card').first()).not.toHaveAttribute('open', '');
    await emit(
      tool('read2', 'read', 'Read', {
        revision: 2,
        path: '/fixture/menu.ts',
        facts: [{ label: 'Lines read', value: '8' }],
      }),
    );
    await emit(tool('read3', 'read', 'Read', { path: '/fixture/tests.ts' }));
    await expect(groups.first()).toHaveAttribute('open', '');
    await expect(groups.first().locator('.tool-card')).toHaveCount(3);
    await groups.first().locator('.tool-card > summary').nth(1).click();
    await expect(page.getByText('Lines read', { exact: true })).toBeVisible();
    await groups.first().locator(':scope > summary').focus();
    await page.keyboard.press('Space');
    await emit({
      kind: 'progress',
      id: 'middle',
      revision: 1,
      text: 'The source is ready. I will update it and run the checks.',
    });
    await emit(tool('edit', 'edit', 'Edit', { path: '/fixture/app.ts' }));
    await emit(
      tool('run', 'command', 'Run command', {
        commandRun: true,
        status: 'running',
        detail: 'Run the fixture tests',
      }),
    );
    await expect(groups).toHaveCount(2);
    await expect(groups.last().locator(':scope > summary')).toContainText(
      'Editing files and running commands',
    );
    await expect(groups.last()).not.toHaveAttribute('open', '');
    await page.getByLabel('Message', { exact: true }).fill('Keep my next message');
    await page.screenshot({
      path: `artifacts/grouped-activity-running-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await emit(
      tool('run', 'command', 'Run command', {
        commandRun: true,
        revision: 2,
        status: 'error',
        detail: 'Run the fixture tests',
        facts: [{ label: 'Exit code', value: '1' }],
      }),
    );
    await expect(groups.last().locator(':scope > summary')).toContainText('Failed');
    await expect(groups.last().locator(':scope > summary')).not.toContainText('Edited files');
    await emit({ kind: 'text', text: 'The update is ready, but a check failed.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    const history = page.locator('.activity-summary');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(page.getByLabel('Work history', { exact: true })).toHaveText('Work history');
    await page.getByLabel('Work history', { exact: true }).click();
    await expect(history.getByLabel('Filter activity')).toHaveCount(0);
    await expect(groups).toHaveCount(2);
    await expect(groups.locator(':scope > summary')).toHaveText([
      'Read files',
      'File edits and commands Failed',
    ]);
    await expect(page.locator('.activity-group[open], .tool-card[open]')).toHaveCount(0);
    const sequence = () =>
      page
        .locator('.activity-timeline')
        .evaluate((el) =>
          [...el.children].map((child) =>
            (child.querySelector(':scope > summary') ?? child).textContent?.trim(),
          ),
        );
    const savedSequence = await sequence();
    expect(savedSequence).toEqual([
      'Connected',
      'I will check the source files.',
      'Read files',
      'The source is ready. I will update it and run the checks.',
      'File edits and commands Failed',
    ]);
    await page
      .locator('.chat-scroll')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
    await page.screenshot({
      path: `artifacts/grouped-activity-history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await groups.last().locator(':scope > summary').click();
    await groups.last().locator('.tool-card > summary').last().click();
    await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my next message');
    expect(await history.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
    expect(await sequence()).toEqual(savedSequence);
    await expect(page.locator('.activity-group[open], .tool-card[open]')).toHaveCount(0);
    await expect(page.getByLabel('Work history', { exact: true })).toHaveText('Work history');
    await expect(history.getByLabel('Filter activity')).toHaveCount(0);
    await expect(groups).toHaveCount(2);
    await groups.last().locator(':scope > summary').click();
    await groups.last().locator('.tool-card > summary').last().click();
    await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
  });

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
    await expect(toggle).toHaveText('Work history');
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
