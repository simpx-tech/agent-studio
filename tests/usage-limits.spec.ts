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
async function limitedReply(page: Page) {
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
  await emit({ kind: 'usagelimit', usageLimit: { revision: 1, text: line } });
  const reply = page.locator('[data-testid="message"]').last();
  // The limit shows at once, while the reply still runs.
  await expect(reply.locator('.usage-limit')).toContainText(line);
  await expect(reply.locator('.usage-limit')).not.toContainText('Send a message');
  await page.evaluate((error) => (window as any).failCapabilities(error), line);
  await expect(reply).toHaveAttribute('data-status', 'error');
  return reply;
}

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
