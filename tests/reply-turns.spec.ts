import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// A Claude reply goes on through several turns: one ends while background work continues, and
// the next begins when that work reports or the user steers the reply. Each turn's last text is
// one of the reply's comments and, from the turn's end until the next begins, its answer.
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const comment = (id: string, text: string) => ({ kind: 'progress', id, revision: 1, text });
const command = (id: string, text: string) => ({
  kind: 'tool',
  tool: {
    id,
    operation: 'command',
    name: 'Bash',
    category: 'tool',
    revision: 1,
    status: 'complete',
    command: text,
    commandRun: true,
    facts: [],
    sources: [],
    agents: [],
  },
});
// The reply's answer, apart from the comments of its work.
const answer = (reply: Locator) => reply.locator(':scope > .message-content > .prose');
/** The texts the reply shows, in the order they read from top to bottom. */
const reading = (reply: Locator, texts: string[]) =>
  reply.evaluate((article, texts) => {
    const shown = (article as HTMLElement).innerText;
    return texts
      .filter((text) => shown.includes(text))
      .sort((a, b) => shown.indexOf(a) - shown.indexOf(b));
  }, texts);
const times = (reply: Locator, text: string) =>
  reply.evaluate(
    (article, text) => (article as HTMLElement).innerText.split(text).length - 1,
    text,
  );

const waited = 'The cone tree is done and pushed. The pine is building now.';

/** A reply whose turn ended with its text while a background agent works on. */
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
  await input.fill('Build the nine trees');
  await input.press('Enter');
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await emit(page, command('push', 'git push origin trees'));
  // As the computer running the reply reports a turn's end.
  await emit(page, comment('turn-1', waited));
  await emit(page, { kind: 'text', text: waited });
  await emit(page, { kind: 'activity', text: 'Waiting for background work to finish' });
  await emit(page, { kind: 'backgroundwait', wait: 1 });
  const reply = page.getByTestId('message').last();
  await expect(reply.getByText('Waiting for background work', { exact: true })).toBeVisible();
  // While it waits, the turn's text is the reply's answer, shown once.
  await expect(answer(reply)).toHaveText(waited);
  expect(await times(reply, waited)).toBe(1);
  return reply;
}

test('what a reply does after waiting for background work follows the text it waited with', async ({
  page,
}) => {
  const reply = await waitingReply(page);
  // The agent reported, so Claude goes on by itself: the answer starts again with the turn.
  await emit(page, { kind: 'backgroundwait', wait: null });
  await emit(page, { kind: 'text', text: '' });
  await expect(reply.getByText('Responding', { exact: true })).toBeVisible();
  // The text stays where it was written, now as the last comment of the reply's work.
  await expect(answer(reply)).toHaveCount(0);
  expect(await times(reply, waited)).toBe(1);
  await emit(page, comment('turn-2', 'The pine is built. Checking it against the reference.'));
  await emit(page, command('check', 'blender --check pine'));
  const later = ['The pine is built.', 'blender --check pine'];
  await expect(reply).toContainText(later[1]);
  expect(await reading(reply, [later[1], waited, later[0]])).toEqual([waited, ...later]);
  await expect(answer(reply)).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/reply-turns/continued.png' });

  // The turn that ends the reply leaves its own text as the answer.
  await emit(page, comment('turn-2-end', 'All nine trees are done.'));
  await emit(page, { kind: 'text', text: 'All nine trees are done.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(reply).toHaveAttribute('data-status', 'complete');
  await expect(answer(reply)).toHaveText('All nine trees are done.');
  // The earlier turn's text is part of the Work history, in the place it was written.
  expect(await times(reply, waited)).toBe(0);
  await reply.locator('summary[aria-label="Work history"]').click();
  await expect(reply).toContainText(waited);
  expect(await reading(reply, ['All nine trees are done.', later[0], waited])).toEqual([
    waited,
    later[0],
    'All nine trees are done.',
  ]);
  expect(await times(reply, 'All nine trees are done.')).toBe(1);
});

test('a steer sent while the reply waits stands after the text it was sent after', async ({
  page,
}) => {
  const reply = await waitingReply(page);
  // The steer starts another turn. The computer running the reply empties the answer as the
  // turn begins, then confirms the steer.
  await page.evaluate(() => ((window as any).holdSteering = true));
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Stop for now, we will continue later');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await emit(page, { kind: 'backgroundwait', wait: null });
  await emit(page, { kind: 'text', text: '' });
  await page.evaluate(() => (window as any).releaseSteering());
  const steer = page.getByRole('group', { name: 'Steering message' });
  await expect(steer).toContainText('Stop for now, we will continue later');
  const parts = reply.locator(':scope > .message-content');
  await expect(parts).toHaveCount(2);
  // Nothing has followed the steer yet, and the text from before it is not below it.
  await expect(parts.last().locator('.reply-waiting')).toBeVisible();
  await expect(parts.first()).toContainText(waited);
  await expect(parts.last()).not.toContainText(waited);

  const stopping = 'Stopping the pine’s agent, then checking what it left.';
  await emit(page, comment('turn-2', stopping));
  await emit(page, command('look', 'git status --short'));
  await expect(parts.last()).toContainText('git status --short');
  // Top to bottom: what the reply wrote before the steer, the steer, what it did about it.
  const order = [waited, 'Stop for now, we will continue later', stopping, 'git status --short'];
  expect(await reading(reply, [...order].reverse())).toEqual(order);
  expect(await times(reply, waited)).toBe(1);
  await expect(parts.first()).not.toContainText(stopping);
  await expect(answer(reply)).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/reply-turns/steered.png' });

  // Stopped there, the reply ends with what it wrote after the steer; the text from before it
  // stays with the work before the steer.
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(reply).toHaveAttribute('data-status', 'cancelled');
  await expect(parts.last().locator(':scope > .prose')).toHaveText(stopping);
  await expect(reply).not.toContainText(waited);
  await parts.first().locator('summary[aria-label="Work history"]').click();
  await expect(parts.first()).toContainText(waited);
  await expect(parts.last()).not.toContainText(waited);
  await page.screenshot({ path: 'artifacts/reply-turns/stopped.png' });
});
