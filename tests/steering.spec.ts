import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// A steer the reply took: the user's own message, marked as a steer.
const steers = (page: Page) => page.getByRole('group', { name: 'Steering message' });
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const call = (id: string, operation: string, name: string, extra = {}) => ({
  kind: 'tool',
  tool: {
    id,
    operation,
    name,
    category: 'tool',
    revision: 1,
    status: 'complete',
    facts: [],
    sources: [],
    agents: [],
    ...extra,
  },
});
async function steer(page: Page, text: string) {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill(text);
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(input).toHaveValue('');
}
// The reply as it reads from top to bottom: each part of its work under a heading of its own,
// and each steer between two of them.
const outline = (page: Page) =>
  page
    .getByTestId('message')
    .last()
    .evaluate((article) =>
      [...article.children].flatMap((child) =>
        child.classList.contains('steer-message')
          ? [`steer: ${child.querySelector('.user-text')!.textContent}`]
          : child.classList.contains('message-content')
            ? ['reply']
            : [],
      ),
    );
// A reply that read a file and commented, was steered, then ran a command.
async function steeredReply(page: Page) {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Fix the login redirect');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await emit(page, call('read1', 'read', 'Read', { path: 'C:\\app\\src\\auth.ts' }));
  await emit(page, { kind: 'progress', id: 'p1', revision: 1, text: 'Reading the handler.' });
  await steer(page, 'Also cover the signup flow');
  await emit(
    page,
    call('run1', 'command', 'Bash', { command: 'npm test -- signup', commandRun: true }),
  );
}
async function finish(page: Page, text = 'Both flows are fixed.') {
  await emit(page, { kind: 'text', text });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
}
async function reopen(page: Page) {
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('#conversation-panel-history .conversation-item').first().click();
  await expect(steers(page)).toHaveCount(1);
}

test('steers the active reply, keeps queue behavior, and restores accepted history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeVisible();
  await input.fill('Check the tests first');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(input).toHaveValue('');
  await expect(steers(page)).toContainText('Check the tests first');
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  const sent = await page.evaluate(() => (window as any).steeringSent[0]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(sent.runId).toBe(request.runId);
  expect(sent.connectionId).toBe(request.agent.connectionId);
  await input.fill('/some-skill');
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeDisabled();
  await input.fill('Do this afterward');
  await input.press('Enter');
  await expect(page.getByRole('list', { name: 'Queued messages' })).toContainText(
    'Do this afterward',
  );
  await page.screenshot({ path: 'artifacts/steering/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/steering/mobile.png' });
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(input).toHaveValue('Do this afterward');
  await input.fill('Continue');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  const next = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(
    next.messages.some((m: { text: string }) => m.text.includes('Check the tests first')),
  ).toBe(true);
});

test('failed delivery preserves text, and a late confirmation cannot erase a newer draft', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await page.evaluate(() => ((window as any).steeringFailure = true));
  await input.fill('Correction');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(page.getByRole('alert')).toContainText('Your steering was not sent');
  await expect(input).toHaveValue('Correction');
  await expect(steers(page)).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).steeringFailure = false;
    (window as any).holdSteering = true;
  });
  await input.fill('New correction');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeDisabled();
  // Only a steer the reply took becomes a message.
  await expect(steers(page)).toHaveCount(0);
  await input.fill('Keep this draft');
  await page.evaluate(() => (window as any).releaseSteering());
  await expect(steers(page)).toContainText('New correction');
  await expect(input).toHaveValue('Keep this draft');
});

test('retry retains the stopped attempt and its accepted steering', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await input.fill('Preserve the existing file');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  await expect(steers(page)).toContainText('Preserve the existing file');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(
    request.messages.some((m: { text: string }) => m.text.includes('Preserve the existing file')),
  ).toBe(true);
  expect(request.messages.at(-1).text).toContain('including my steering');
});

for (const mobile of [false, true])
  test(`a steer is the user's own message where the reply took it ${mobile ? 'mobile' : 'desktop'} @webkit`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await steeredReply(page);
    const reply = page.getByTestId('message').last();
    const parts = reply.locator(':scope > .message-content');
    // The reply's work up to the steer, the steer, then the reply going on under its own heading.
    expect(await outline(page)).toEqual(['reply', 'steer: Also cover the signup flow', 'reply']);
    await expect(parts.first()).toContainText('Read 1 file');
    await expect(parts.first()).toContainText('Reading the handler.');
    await expect(parts.first()).not.toContainText('npm test');
    await expect(parts.last()).toContainText('npm test -- signup');
    await expect(parts.last()).not.toContainText('Reading the handler.');
    // Only the part the reply is in says it is responding, from the time it took the steer.
    await expect(parts.first().locator('.live-label')).toHaveCount(0);
    await expect(parts.last().locator('.live-label')).toHaveText('Responding');
    await expect(parts.last().locator('.message-heading > span').first()).toHaveText(/\d:\d\d/);
    // It is marked as a steer and reads as sent by the user.
    await expect(steers(page).locator('.steer-mark')).toHaveText('Steer');
    await expect(steers(page)).toContainText(/^You \d/);
    // The bubble is one of the user's own: at the conversation's right edge like the message
    // above, with the mark above it and the reply continuing below.
    const edges = () =>
      steers(page).evaluate((steer) => {
        const box = (element: Element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const articles = [...document.querySelectorAll('article.message')];
        const part = steer.nextElementSibling!.nextElementSibling!;
        return {
          own: box(articles[0].querySelector('.user-text')!),
          bubble: box(steer.querySelector('.user-text')!),
          mark: box(steer.querySelector('.steer-mark')!),
          before: box(steer.previousElementSibling!),
          after: box(part),
          style: {
            own: getComputedStyle(articles[0].querySelector('.user-text')!).backgroundColor,
            bubble: getComputedStyle(steer.querySelector('.user-text')!).backgroundColor,
          },
        };
      });
    const live = await edges();
    expect(Math.abs(live.bubble.right - live.own.right)).toBeLessThanOrEqual(1);
    expect(live.bubble.left).toBeGreaterThan(live.after.left);
    expect(live.style.bubble).toBe(live.style.own);
    expect(live.mark.top).toBeGreaterThanOrEqual(live.before.bottom);
    expect(live.mark.bottom).toBeLessThanOrEqual(live.bubble.top);
    expect(live.after.top).toBeGreaterThan(live.bubble.bottom);
    await page.screenshot({
      path: `artifacts/steering/placed-running-${mobile ? 'mobile' : 'desktop'}.png`,
    });

    await finish(page);
    // Each part keeps its own work in its own history; the answer follows the last.
    expect(await outline(page)).toEqual(['reply', 'steer: Also cover the signup flow', 'reply']);
    const histories = reply.locator('summary[aria-label="Work history"]');
    await expect(histories).toHaveCount(2);
    await histories.first().click();
    await expect(parts.first()).toContainText('Read 1 file');
    await expect(parts.first()).not.toContainText('Ran 1 command');
    await histories.last().click();
    await expect(parts.last()).toContainText('Ran 1 command');
    await expect(parts.last()).toContainText('Both flows are fixed.');
    await expect(parts.first()).not.toContainText('Both flows are fixed.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const done = await edges();
    expect(Math.abs(done.bubble.right - done.own.right)).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `artifacts/steering/placed-${mobile ? 'mobile' : 'desktop'}.png`,
    });

    // The place is saved with the reply, beside its receipt.
    const saved = await page.evaluate(() => {
      const [chat] = JSON.parse(localStorage.getItem('test-workspace')!).conversations;
      const message = chat.messages.at(-1);
      return { steering: message.steering, places: message.steeringPlaces };
    });
    expect(saved.places).toEqual([
      // After the mock's connection note, the read and the comment.
      { id: saved.steering[0].id, after: 3, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    ]);
    expect(Object.keys(saved.steering[0]).sort()).toEqual(['id', 'runId', 'sequence', 'text']);
    await page.setViewportSize({ width: 1380, height: 900 });
    await reopen(page);
    expect(await outline(page)).toEqual(['reply', 'steer: Also cover the signup flow', 'reply']);
  });

test('a steer saved without its place follows the reply’s work', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await steeredReply(page);
  await finish(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [chat] = JSON.parse(localStorage.getItem('test-workspace')!).conversations;
        return chat.messages.at(-1).status;
      }),
    )
    .toBe('complete');
  // As releases before 2026-10-13 saved it, and as an older relay returns it.
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    delete workspace.conversations[0].messages.at(-1).steeringPlaces;
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await reopen(page);
  expect(await outline(page)).toEqual(['reply', 'steer: Also cover the signup flow', 'reply']);
  const reply = page.getByTestId('message').last();
  const parts = reply.locator(':scope > .message-content');
  const histories = reply.locator('summary[aria-label="Work history"]');
  // All of the reply's work comes before the steer, and only the answer after it.
  await expect(histories).toHaveCount(1);
  await histories.click();
  await expect(parts.first()).toContainText('Read 1 file');
  await expect(parts.first()).toContainText('Ran 1 command');
  await expect(parts.last()).toContainText('Both flows are fixed.');
  // No time was recorded for it either.
  await expect(parts.last().locator('.message-heading > span')).toHaveCount(0);
  await expect(steers(page)).toContainText(/^You\s*Steer/);
});

test('a reply stopped after a steer keeps its earlier comment with the work before it', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Run the tests');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await emit(page, { kind: 'progress', id: 'p1', revision: 1, text: 'I will run npm test.' });
  await steer(page, 'Use pnpm instead');
  const reply = page.getByTestId('message').last();
  const parts = reply.locator(':scope > .message-content');
  // Nothing has followed the steer yet: the reply is about to go on from it.
  await expect(parts.last().locator('.reply-waiting')).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(reply).toHaveAttribute('data-status', 'cancelled');
  expect(await outline(page)).toEqual(['reply', 'steer: Use pnpm instead', 'reply']);
  // The comment written before the steer is not an answer to it.
  await expect(parts.last()).toContainText('Response stopped.');
  await expect(parts.last()).not.toContainText('I will run npm test.');
  await expect(parts.last().locator('summary[aria-label="Work history"]')).toHaveCount(0);
  await parts.first().locator('summary[aria-label="Work history"]').click();
  await expect(parts.first()).toContainText('I will run npm test.');
  // The reply stopped in its last part, which alone says so.
  await expect(parts.first().locator('.tool-status')).toHaveCount(0);
});

test('steers before the reply’s first work stand above it, with no heading between them', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Run the tests');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await steer(page, 'Use pnpm instead');
  await steer(page, 'And only the unit tests');
  await emit(
    page,
    call('run1', 'command', 'Bash', { command: 'pnpm test:unit', commandRun: true }),
  );
  await finish(page, 'The unit tests pass.');
  const rows = () =>
    page
      .getByTestId('message')
      .last()
      .evaluate((article) =>
        [...article.children].map((child) =>
          child.classList.contains('steer-message')
            ? 'steer'
            : child.classList.contains('message-content')
              ? 'reply'
              : child.classList.contains('message-avatar')
                ? 'avatar'
                : child.className,
        ),
      );
  // The mock's connection note shows before the steers; no part stands between the two.
  expect(await rows()).toEqual(['avatar', 'reply', 'steer', 'steer', 'avatar', 'reply']);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [chat] = JSON.parse(localStorage.getItem('test-workspace')!).conversations;
        return chat.messages.at(-1).status;
      }),
    )
    .toBe('complete');
  // A real reply starts with notes its history hides, so a steer it took before its first call
  // has nothing of the reply above it.
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const [note] = workspace.conversations[0].messages.at(-1).blocks;
    if (note.text !== 'Connected') throw new Error(`Unexpected first block: ${note.text}`);
    note.text = 'Connected to Claude';
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('#conversation-panel-history .conversation-item').first().click();
  await expect(steers(page)).toHaveCount(2);
  expect(await rows()).toEqual(['steer', 'steer', 'avatar', 'reply']);
  const reply = page.getByTestId('message').last();
  await expect(reply.locator(':scope > .message-content')).toContainText('The unit tests pass.');
  // The first steer follows the user's message as closely as the reply would.
  const gap = await reply.evaluate((article) => {
    const own = article.previousElementSibling!.querySelector('.user-text')!;
    const first = article.querySelector('.steer-message .steer-mark')!;
    return first.getBoundingClientRect().top - own.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThan(20);
  expect(gap).toBeLessThan(60);
  await page.screenshot({ path: 'artifacts/steering/leading.png' });
});
