import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const runCount = (page: Page) => page.evaluate(() => localStorage.getItem('test-run-count'));
const lastRequest = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));

/** A Claude reply whose turn ended while its background agents work on. */
async function waitingReply(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Plan the overhaul');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  const first = await lastRequest(page);
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'I will write the plan once the agents report back.' });
    w.emitCapability({ kind: 'activity', text: 'Waiting for background work to finish' });
    w.emitCapability({ kind: 'backgroundwait', wait: 1 });
  });
  return { input, first };
}

test('a message sent while Claude only waits for background work goes at once', async ({
  page,
}) => {
  const { input, first } = await waitingReply(page);
  const messages = page.getByTestId('message');
  // The reply reads as idle, and the composer sends instead of queueing.
  await expect(messages.nth(1).getByText('Waiting for background work', { exact: true })).toBeVisible();
  await expect(messages.nth(1).getByText('Responding', { exact: true })).toHaveCount(0);
  await expect(input).not.toHaveAttribute('placeholder', /after this reply/);
  await page.screenshot({ path: 'artifacts/take-over/waiting.png' });
  await input.fill('Here is the image I mentioned');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => runCount(page)).toBe('2');
  const next = await lastRequest(page);
  expect(next.takeOver).toMatchObject({ runId: first.runId, wait: 1 });
  expect(next.takeOver.messages).toHaveLength(2);
  expect(next.takeOver.messages[1]).toMatchObject({ id: next.assistantId, runId: next.runId });
  // Its history ends the waiting reply with the text it had.
  expect(next.messages.slice(-2)).toMatchObject([
    { role: 'assistant', text: 'I will write the plan once the agents report back.' },
    { role: 'user', text: 'Here is the image I mentioned' },
  ]);
  // The waiting reply ended; the message and its reply follow it, nothing stays queued.
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(1)).toHaveAttribute('data-status', 'complete');
  await expect(messages.nth(2)).toContainText('Here is the image I mentioned');
  await expect(messages.nth(3)).toHaveAttribute('data-status', 'running');
  await expect(input).toHaveValue('');
  await page.screenshot({ path: 'artifacts/take-over/sent.png' });
  // The new reply answers, waits for the agents in turn, and ends with the plan.
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'Noted. The plan follows once the agents report.' });
    w.emitCapability({ kind: 'backgroundwait', wait: 1 });
  });
  await expect(messages.nth(3).getByText('Waiting for background work', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'backgroundwait', wait: null });
    w.emitCapability({ kind: 'text', text: 'The plan is ready.' });
    w.finishCapabilities('complete');
  });
  await expect(messages.nth(3)).toHaveAttribute('data-status', 'complete');
  await expect(messages.nth(3)).toContainText('The plan is ready.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('a refused take-over keeps the message queued for the reply', async ({ page }) => {
  const { input, first } = await waitingReply(page);
  await page.evaluate(
    () =>
      ((window as any).refuseTakeOver =
        'Claude started working again, so your message waits until it is idle or the reply finishes.'),
  );
  await input.fill('Also check the spawners');
  await input.press('Enter');
  await expect.poll(() => runCount(page)).toBe('2');
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('Also check the spawners')).toBeVisible();
  await expect(queue.getByText('After this reply')).toBeVisible();
  const messages = page.getByTestId('message');
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(1)).toHaveAttribute('data-status', 'running');
  // Refused once in this idle stretch, it does not ask again until the next one.
  await page.waitForTimeout(300);
  expect(await runCount(page)).toBe('2');
  await page.evaluate(() => {
    const w = window as any;
    w.refuseTakeOver = undefined;
    w.emitCapability({ kind: 'backgroundwait', wait: null });
    w.emitCapability({ kind: 'text', text: 'One agent reported. Waiting for the rest.' });
    w.emitCapability({ kind: 'backgroundwait', wait: 2 });
  });
  await expect.poll(() => runCount(page)).toBe('3');
  const next = await lastRequest(page);
  expect(next.takeOver).toMatchObject({ runId: first.runId, wait: 2 });
  expect(next.messages.at(-2)).toMatchObject({
    role: 'assistant',
    text: 'One agent reported. Waiting for the rest.',
  });
  await expect(queue).toHaveCount(0);
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(2)).toContainText('Also check the spawners');
});

test('a message waits for a reply that is working, or whose next reply needs a new process', async ({
  page,
}) => {
  const { input } = await waitingReply(page);
  // Other launch settings need a new process, which would end the background work.
  const reasoning = page.getByRole('combobox', { name: 'Reasoning', exact: true });
  const other = (await reasoning.textContent())?.includes('Low') ? 'High' : 'Low';
  await reasoning.click();
  await page.getByRole('option', { name: other, exact: true }).click();
  await expect(reasoning).toContainText(other);
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
  await input.fill('After the agents');
  await input.press('Enter');
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('After the agents')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await runCount(page)).toBe('1');
  // It goes once the reply ends, as before.
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'The plan is ready.' });
    w.finishCapabilities('complete');
  });
  await expect.poll(() => runCount(page)).toBe('2');
  expect((await lastRequest(page)).takeOver).toBeUndefined();
  await expect(queue).toHaveCount(0);
});
