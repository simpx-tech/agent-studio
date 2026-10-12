import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const column = (page: Page) => page.locator('.message-column');
const divisions = (page: Page) => column(page).locator(':scope > .message-day');
// How far the open conversation is scrolled above its end.
const fromEnd = (page: Page) =>
  page
    .locator('.chat-scroll')
    .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

async function start(page: Page) {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
}
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
}
// Noon of the day `ago` days before today, on the reader's clock.
const noon = (page: Page, ago: number) =>
  page.evaluate((ago) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, 12).getTime();
  }, ago);
// Saves the chat as one whose questions were asked `ago[i]` days back, each with its reply (the
// first one `paragraphs` long), then starts the app again and opens the chat from History.
async function openDated(page: Page, title: string, ago: number[], paragraphs = 0) {
  const times = await Promise.all(ago.map((days) => noon(page, days)));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const [chat] = JSON.parse(localStorage.getItem('test-workspace')!).conversations;
        return chat.messages.filter((m: { status: string }) => m.status === 'complete').length;
      }),
    )
    .toBe(ago.length * 2);
  await page.evaluate(
    ({ times, paragraphs }) => {
      const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
      const [chat] = workspace.conversations;
      chat.messages.forEach((message: { createdAt: string }, i: number) => {
        message.createdAt = new Date(times[i >> 1] + (i % 2) * 60_000).toISOString();
      });
      chat.createdAt = chat.messages[0].createdAt;
      if (paragraphs)
        chat.messages[1].blocks = [
          {
            type: 'markdown',
            text: Array.from({ length: paragraphs }, (_, i) => `Earlier paragraph ${i + 1}.`).join(
              '\n\n',
            ),
          },
        ];
      localStorage.setItem('test-workspace', JSON.stringify(workspace));
    },
    { times, paragraphs },
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .locator('#conversation-panel-history')
    .getByRole('button', { name: title, exact: true })
    .click();
  await expect(page.getByTestId('message')).toHaveCount(ago.length * 2);
}
// The conversation as it reads: each division's name, and who wrote each message.
const listed = (page: Page) =>
  column(page).evaluate((element) =>
    [...element.children].flatMap((child) =>
      child.classList.contains('message-day')
        ? [`— ${child.textContent!.trim()} —`]
        : (child as HTMLElement).dataset.messageId
          ? [child.classList.contains('user') ? 'You' : 'Reply']
          : [],
    ),
  );
const dateOf = (page: Page, time: number, options: Intl.DateTimeFormatOptions) =>
  page.evaluate(([time, options]) => new Date(time).toLocaleDateString([], options), [
    time,
    options,
  ] as const);

test('a chat continued on another day shows where each day begins', async ({ page }) => {
  await start(page);
  await send(page, 'First question');
  await send(page, 'Second question');
  await send(page, 'Third question');
  // A chat from today has no division.
  await expect(page.getByTestId('message')).toHaveCount(6);
  await expect(divisions(page)).toHaveCount(0);

  await openDated(page, 'First question', [3, 1, 0]);
  const weekday = await dateOf(page, await noon(page, 3), { weekday: 'long' });
  expect(await listed(page)).toEqual([
    `— ${weekday} —`,
    'You',
    'Reply',
    '— Yesterday —',
    'You',
    'Reply',
    '— Today —',
    'You',
    'Reply',
  ]);
  // Each is a named separator, with the full date on hover.
  const yesterday = divisions(page).nth(1);
  await expect(yesterday).toHaveRole('separator');
  await expect(yesterday).toHaveAccessibleName('Yesterday');
  await expect(yesterday.locator('span')).toHaveAttribute(
    'title',
    await dateOf(page, await noon(page, 1), { dateStyle: 'full' }),
  );
  // Another message today stays under Today.
  await send(page, 'Fourth question');
  expect((await listed(page)).slice(-5)).toEqual(['— Today —', 'You', 'Reply', 'You', 'Reply']);
  await expect(divisions(page)).toHaveCount(3);
});

test('a chat open across midnight gains its divisions', async ({ page }) => {
  // Half a minute to midnight on the reader's clock.
  const today = new Date();
  await page.clock.install({
    time: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 30),
  });
  await start(page);
  await send(page, 'A late question');
  await expect(divisions(page)).toHaveCount(0);
  // The day moves on as it begins, before the minute timer would notice.
  const left = await page.evaluate(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  });
  await page.clock.fastForward(left + 1000);
  await expect(divisions(page)).toHaveText(['Yesterday']);
  await send(page, 'An early question');
  expect(await listed(page)).toEqual([
    '— Yesterday —',
    'You',
    'Reply',
    '— Today —',
    'You',
    'Reply',
  ]);
});

for (const phone of [false, true])
  test(`a chat from another day opens with its day and continues under Today${phone ? ' on a phone' : ''} @webkit`, async ({
    page,
  }) => {
    await start(page);
    await send(page, 'Yesterday question');
    await openDated(page, 'Yesterday question', [1], 60);
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    expect(await listed(page)).toEqual(['— Yesterday —', 'You', 'Reply']);
    // It opens at its end, and a message sent from there is followed past its division.
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    await expect(divisions(page).first()).not.toBeInViewport();
    await send(page, 'A question today');
    expect(await listed(page)).toEqual([
      '— Yesterday —',
      'You',
      'Reply',
      '— Today —',
      'You',
      'Reply',
    ]);
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    // A phone shows the end of the reply, which is taller than what its view leaves.
    if (!phone) await expect(divisions(page).last()).toBeInViewport();
    // Each division spans the conversation with its name in the middle, clear of the messages
    // around it.
    const layout = await column(page).evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const left = box.left + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.paddingRight);
      return [...element.querySelectorAll(':scope > .message-day')].map((division) => {
        const own = division.getBoundingClientRect();
        const name = division.querySelector('span')!.getBoundingClientRect();
        const before = division.previousElementSibling?.getBoundingClientRect();
        const after = division.nextElementSibling!.getBoundingClientRect();
        return {
          spans: Math.abs(own.left - left) < 1 && Math.abs(own.right - right) < 1,
          centered: Math.abs((name.left + name.right) / 2 - (left + right) / 2) < 1,
          lines: name.left - own.left > 24,
          clear: (!before || before.bottom <= own.top) && own.bottom <= after.top,
        };
      });
    });
    expect(layout).toEqual(
      Array.from({ length: 2 }, () => ({ spans: true, centered: true, lines: true, clear: true })),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `artifacts/chat-days${phone ? '-phone' : ''}-${test.info().project.name}.png`,
      animations: 'disabled',
    });
  });
