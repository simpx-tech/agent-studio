import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const line = "You've hit your session limit · resets 1:50pm (America/Sao_Paulo)";
const lastComment = 'The generator places features by chance. Next I will widen the map.';

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

// A reply that reads a file between two comments, then stops at the account's session limit.
async function limitedReply(page: Page, limit = line) {
  await page.getByLabel('Message', { exact: true }).fill('Update the generator');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit({ kind: 'progress', id: 'msg_1', revision: 1, text: 'I will read the generator.' });
  await emit({
    kind: 'tool',
    tool: {
      id: 'read',
      operation: 'read',
      name: 'Read',
      category: 'tool',
      revision: 1,
      status: 'complete',
      path: '/fixture/generator.ts',
      sources: [],
      agents: [],
    },
  });
  await emit({ kind: 'progress', id: 'msg_2', revision: 1, text: lastComment });
  await emit({ kind: 'usagelimit', usageLimit: { revision: 1, text: limit } });
  const last = page.locator('[data-testid="message"]').last();
  // The reply keeps its place as the chat goes on after it.
  const reply = page.locator(`[data-message-id="${await last.getAttribute('data-message-id')}"]`);
  // The limit shows at once, while the reply still runs.
  await expect(reply.locator('.usage-limit')).toContainText(limit);
  await expect(reply.locator('.usage-limit')).not.toContainText('Send a message');
  await page.evaluate((error) => (window as any).failCapabilities(error), limit);
  await expect(reply).toHaveAttribute('data-status', 'error');
  return reply;
}

// Claude Code's line for a session limit that resets this many minutes from now on the page's
// clock, written as Claude Code writes it, in the zone it names.
const resettingIn = (page: Page, minutes: number) =>
  page.evaluate((minutes) => {
    const time = new Date(Date.now() + minutes * 60_000)
      .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
      .replace(/\s([AP]M)/i, (_, meridiem: string) => meridiem.toLowerCase());
    return `You've hit your session limit · resets ${time} (UTC)`;
  }, minutes);
const runRequests = (page: Page) =>
  page.evaluate(() => ((window as any).runRequests ?? []) as { messages: unknown[] }[]);
const savedReplies = (page: Page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages as any[],
  );

async function expectStoppedAtLimit(reply: ReturnType<Page['locator']>) {
  const history = reply.locator('.activity-summary');
  await expect(history).toHaveAttribute('open', '');
  await expect(reply.getByLabel('Work history', { exact: true })).toContainText('Limit reached');
  await expect(reply.getByLabel('Work history', { exact: true })).not.toContainText('Failed');
  // Every comment stays in the history, in order; none stands in for an answer.
  await expect(history.locator('.progress-message')).toHaveText([
    'I will read the generator.',
    lastComment,
  ]);
  await expect(history.locator('.activity-group > summary')).toHaveText(['Read 1 file']);
  await expect(reply.getByText(lastComment, { exact: true })).toHaveCount(1);
  // The limit is a card of its own, once, in place of the generic error.
  const card = reply.locator('.usage-limit');
  await expect(card).toHaveAttribute('role', 'status');
  await expect(card).toContainText(line);
  await expect(reply.getByText(line, { exact: true })).toHaveCount(1);
  await expect(reply.locator('.message-error')).toHaveCount(0);
  await expect(reply.locator('.message-heading strong')).not.toContainText('synthetic');
}

test('a reply stopped at a usage limit keeps its history open and shows the limit as a card', async ({
  page,
}) => {
  // Noon in São Paulo, well before the 1:50pm reset the line names, when the chat goes on.
  await page.clock.install({ time: new Date('2026-10-22T12:00:00-03:00') });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  // A second account of the same agent can take the next message.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  const reply = await limitedReply(page);
  await expectStoppedAtLimit(reply);
  // The limit's words are centred beside Switch account, the icon by their first line.
  const box = (selector: string) => reply.locator(selector).first().boundingBox();
  const middle = (b: { y: number; height: number } | null) => b!.y + b!.height / 2;
  expect(
    Math.abs(middle(await box('.usage-limit-text')) - middle(await box('.usage-limit > button'))),
  ).toBeLessThan(1);
  expect(
    Math.abs(middle(await box('.usage-limit-line > svg')) - middle(await box('.usage-limit-text p'))),
  ).toBeLessThan(1.5);
  await page.screenshot({ path: 'artifacts/usage-limit-desktop.png' });

  // The reader can still fold the history; the limit stays in view.
  await reply.getByLabel('Work history', { exact: true }).click();
  await expect(reply.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await expect(reply.locator('.usage-limit')).toBeVisible();
  await reply.getByLabel('Work history', { exact: true }).click();

  // Switch account opens the Agent picker with this agent's accounts.
  await page.getByLabel('Message', { exact: true }).fill('Continue with the map');
  await reply.getByRole('button', { name: 'Switch account', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText([
    /Claude · Claude CLI login/,
    /Claude · Second Claude/,
  ]);
  await page.getByRole('option', { name: 'Claude · Second Claude', exact: true }).click();
  await expect(page.locator('.next-reply-settings')).toHaveText(
    /Next message: Second Claude account/,
  );
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Continue with the map');

  // A reply saved before the limit had a record of its own kept Claude Code's line as a
  // progress comment of a <synthetic> message, with that model and a zero context.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
            .status,
      ),
    )
    .toBe('error');
  await page.evaluate((line) => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const saved = workspace.conversations[0].messages.at(-1);
    delete saved.usageLimit;
    saved.error =
      'The provider CLI could not complete the request. Check its login, model access, and connection, then try again.';
    saved.usage = { model: '<synthetic>', contextInput: 0, input: 5000, output: 20, revision: 1 };
    saved.blocks.push({
      type: 'activity',
      text: line,
      progress: { id: 'b5b9d6d0-8fe4-4efb-a83a-4c65d0b3ef48', revision: 1 },
      order: saved.blocks.length,
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  }, line);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Update the generator', exact: true }).click();
  await expectStoppedAtLimit(page.locator('[data-testid="message"]').last());
});

test('the usage limit card fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const reply = await limitedReply(page);
  await expectStoppedAtLimit(reply);
  // With one account there is nothing to switch to.
  await expect(reply.getByRole('button', { name: 'Switch account' })).toHaveCount(0);
  const card = await reply.locator('.usage-limit').boundingBox();
  const column = await reply.locator('.message-content').boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(column!.x + column!.width + 0.5);
  await page.screenshot({ path: 'artifacts/usage-limit-mobile.png' });
});

test('a chat a usage limit stopped goes on by itself once the limit resets', async ({ page }) => {
  await page.clock.install();
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  const reply = await limitedReply(page, await resettingIn(page, 30));
  // The computer running the chat plans to go on a minute past the reset the line names.
  const plan = reply.locator('.usage-limit-continue');
  await expect(plan).toHaveText(/^Continues at .+Cancel$/);
  await expect(plan.getByRole('button', { name: 'Cancel continuing' })).toBeVisible();
  await expect.poll(async () => (await savedReplies(page))[1].autoContinue?.at).toBeTruthy();
  const at = Date.parse((await savedReplies(page))[1].autoContinue.at);
  const now = await page.evaluate(() => Date.now());
  expect(at - now).toBeGreaterThan(29 * 60_000);
  expect(at - now).toBeLessThanOrEqual(31 * 60_000);
  await page.screenshot({ path: 'artifacts/usage-limit-continues.png' });

  await page.clock.fastForward(20 * 60_000);
  await expect(plan).toContainText('Continues at');
  expect(await runRequests(page)).toHaveLength(1);
  // Its time came: with room on the account again, the chat is sent its next message.
  await page.clock.fastForward(12 * 60_000);
  await expect.poll(() => runRequests(page).then((requests) => requests.length)).toBe(2);
  expect((await runRequests(page))[1].messages.at(-1)).toEqual({
    role: 'user',
    text: 'Continue where you left off.',
  });
  const note = page.locator('.message.continued');
  await expect(note).toHaveText('Continued after the usage limit reset');
  await expect(reply.locator('.usage-limit')).toContainText('resets');
  await expect(plan).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'The map is wider now.' });
    (window as any).finishCapabilities('complete');
  });
  const next = page.locator('[data-testid="message"]').last();
  await expect(next).toHaveAttribute('data-status', 'complete');
  await expect(next).toContainText('The map is wider now.');
  // The note reads as Agent Studio's, never as a message of the user's own.
  await expect(note.getByRole('button', { name: 'Rewind here' })).toHaveCount(0);
  await expect(page.locator('.message.user')).toHaveCount(1);
  const saved = await savedReplies(page);
  expect(saved.map((m) => m.sentBy ?? m.role)).toEqual(['user', 'assistant', 'limit', 'assistant']);
  // The plan was used, so nothing brings it back.
  expect(saved[1].autoContinue.off).toBe(true);
  await page.screenshot({ path: 'artifacts/usage-limit-continued.png' });
});

test('Cancel keeps a chat a usage limit stopped waiting for you', async ({ page }) => {
  await page.clock.install();
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  const reply = await limitedReply(page, await resettingIn(page, 10));
  const plan = reply.locator('.usage-limit-continue');
  await expect(plan).toContainText('Continues at');
  await plan.getByRole('button', { name: 'Cancel continuing' }).click();
  await expect(plan).toHaveCount(0);
  await expect(reply.locator('.usage-limit')).toBeVisible();
  await expect.poll(async () => (await savedReplies(page))[1].autoContinue?.off).toBe(true);
  await page.clock.fastForward(30 * 60_000);
  await page.waitForTimeout(500);
  expect(await runRequests(page)).toHaveLength(1);
  await expect(page.locator('.message.continued')).toHaveCount(0);
});

test('a message of your own uses the plan up, so a rewind back to the limit waits for you', async ({
  page,
}) => {
  await page.clock.install();
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  const reply = await limitedReply(page, await resettingIn(page, 10));
  const plan = reply.locator('.usage-limit-continue');
  await expect(plan).toContainText('Continues at');
  await page.getByLabel('Message', { exact: true }).fill('Widen the map instead');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => runRequests(page).then((requests) => requests.length)).toBe(2);
  await expect(plan).toHaveCount(0);
  await expect.poll(async () => (await savedReplies(page))[1].autoContinue?.off).toBe(true);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Widened.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  // Back to before that message: the limited reply ends the chat again, and waits for you.
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Widen the map instead');
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-message-id',
    (await reply.getAttribute('data-message-id'))!,
  );
  await expect(plan).toHaveCount(0);
  await page.clock.fastForward(30 * 60_000);
  await page.waitForTimeout(500);
  expect(await runRequests(page)).toHaveLength(2);
});

test('a chat waiting to go on after a usage limit still does once the app starts again', async ({
  page,
}) => {
  await page.clock.install();
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  const reply = await limitedReply(page, await resettingIn(page, 10));
  await expect(reply.locator('.usage-limit-continue')).toContainText('Continues at');
  await expect.poll(async () => (await savedReplies(page))[1].autoContinue?.at).toBeTruthy();
  await page.reload();
  // The app started again and put its chats in History, the plan with them.
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveText(/1/);
  await page.clock.fastForward(12 * 60_000);
  await expect.poll(() => runRequests(page).then((requests) => requests.length)).toBe(1);
  expect((await runRequests(page))[0].messages.at(-1)).toEqual({
    role: 'user',
    text: 'Continue where you left off.',
  });
  // Going on brings it back to Active.
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveText(/1/);
  await expect.poll(async () => (await savedReplies(page)).at(-2).sentBy).toBe('limit');
});
