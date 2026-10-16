import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { mockHostBackground } from './background-helper';
import { chooseTestFolder } from './folder-helper';
import { chooseReasoning } from './reasoning-helper';

const runCount = (page: Page) => page.evaluate(() => localStorage.getItem('test-run-count'));
const lastRequest = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));

/** A Claude reply whose turn ended while its background agents work on. */
async function waitingReply(page: Page) {
  await mockDesktop(page, 'capabilities');
  await mockHostBackground(page);
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

test('the reply that took over lists the sub-agents it waits for, which their reply keeps', async ({
  page,
}) => {
  const { input, first } = await waitingReply(page);
  const agents = (revision: number, agent: Record<string, unknown>) => ({
    id: 'claude:agents',
    name: 'Sub-agents',
    category: 'agent',
    revision,
    status: agent.status,
    sources: [],
    agents: [agent],
  });
  const skill = {
    id: 'toolu_skill',
    name: 'Update the skill',
    status: 'running',
    background: true,
    task: 'Bring the skill up to date',
  };
  const read = {
    id: 'claude:read',
    name: 'Read',
    category: 'tool',
    operation: 'read',
    path: '/fixture/notes.md',
    parentId: skill.id,
    revision: 1,
    status: 'running',
    sources: [],
    agents: [],
  };
  await page.evaluate(
    (tools) => tools.forEach((tool) => (window as any).emitCapability({ kind: 'tool', tool })),
    [agents(1, skill), read],
  );
  await input.fill('Only for the art work');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => runCount(page)).toBe('2');
  // The new reply names the reply it took over, on every device that adds it.
  const next = await lastRequest(page);
  expect(next.takeOver.messages[1]).toMatchObject({ tookOver: first.assistantId });
  const messages = page.getByTestId('message');
  await expect(messages.nth(3)).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'Understood. I told the agent.' });
    w.emitCapability({ kind: 'backgroundwait', wait: 1 });
  });
  // The earlier reply ended, so its footer no longer lists the agent; the reply that waits for
  // it does, and opens the conversation the earlier reply keeps.
  const toggle = (index: number) =>
    messages.nth(index).locator('.reply-footer .progress-toggle', { hasText: 'Sub-agents' });
  await expect(toggle(1)).toHaveCount(0);
  await expect(toggle(3)).toHaveText(/Sub-agents\s*1/);
  await toggle(3).click();
  const item = messages.nth(3).getByRole('region', { name: 'Sub-agents' }).getByRole('button');
  await expect(item).toHaveText(/Update the skill[\s\S]*In background\s*1 call/);
  await item.click();
  const panel = page.getByRole('dialog', { name: 'Update the skill' });
  await expect(panel.locator('.status')).toHaveText('Running in the background');
  await expect(panel).toContainText('Bring the skill up to date');
  await expect(panel).not.toContainText('No result was reported');
  await expect(item).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: 'artifacts/take-over/inherited.png' });
  // The earlier reply's history says it works on in the background, not that it was left.
  await messages.nth(1).getByLabel('Work history', { exact: true }).click();
  await messages.nth(1).locator('.activity-group > summary').first().click();
  const row = messages.nth(1).locator('.subagent-row', { hasText: 'Update the skill' });
  await expect(row).toContainText('In background');
  await expect(row).toHaveAttribute('aria-current', 'true');
  // Its outcome reaches the earlier reply, and the waiting reply lists nothing more.
  await page.evaluate((payload) => (window as any).hostBackground(payload), {
    kind: 'tool',
    conversationId: first.conversationId,
    runId: first.runId,
    tool: agents(2, { ...skill, status: 'complete', result: 'The skill now scopes sub-agents.' }),
  });
  await expect(toggle(3)).toHaveCount(0);
  await expect(panel.locator('.status')).toHaveText('Completed');
  await expect(panel).toContainText('The skill now scopes sub-agents.');
  await expect(row).toContainText('Completed');
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
  await chooseReasoning(page, other);
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

test('a message for an account chosen meanwhile waits for the reply instead of taking it over', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
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
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  await page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true }).click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Plan the overhaul');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  const first = await lastRequest(page);
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'I will write the plan once the agents report back.' });
    w.emitCapability({ kind: 'backgroundwait', wait: 1 });
  });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  // Another account needs a process of its own, which would end the background work.
  await agent.click();
  await page.getByRole('option', { name: 'Claude · Second Claude', exact: true }).click();
  await expect(agent).toContainText('Second Claude');
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
  await input.fill('After the agents, on the second account');
  await input.press('Enter');
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('After the agents, on the second account')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await runCount(page)).toBe('1');
  // It goes to the second account once the reply ends.
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'backgroundwait', wait: null });
    w.emitCapability({ kind: 'text', text: 'The plan is ready.' });
    w.finishCapabilities('complete');
  });
  await expect.poll(() => runCount(page)).toBe('2');
  const next = await lastRequest(page);
  expect(next.takeOver).toBeUndefined();
  expect(next.accountSwitch).toBe(true);
  expect(next.agent.connectionId).not.toBe(first.agent.connectionId);
  expect(next.messages.at(-1)).toMatchObject({
    role: 'user',
    text: 'After the agents, on the second account',
  });
  await expect(queue).toHaveCount(0);
});
