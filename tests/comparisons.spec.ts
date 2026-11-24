import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// Comparisons (docs/COMPARISONS.md): one task sent as several runs side by side.

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const send = (page: Page) => page.getByRole('button', { name: 'Send message', exact: true });
const compare = (page: Page) => page.getByRole('button', { name: 'Compare', exact: true });
const runsPicker = (page: Page) => page.getByRole('group', { name: 'Runs', exact: true });
const comparison = (page: Page) => page.getByRole('region', { name: 'Comparison', exact: true });
const columns = (page: Page) => comparison(page).locator('.comparison-run');
// Replies the mock CLI holds open, in the order they started.
const heldRuns = (page: Page) =>
  page.evaluate(() =>
    Object.entries((window as any).capabilityRuns ?? {}).map(([runId, run]: [string, any]) => ({
      runId,
      conversationId: run.conversationId as string,
    })),
  );
const finish = (page: Page, runId: string, text: string) =>
  page.evaluate(
    ({ runId, text }) => {
      const run = (window as any).capabilityRuns[runId];
      run.emit({ kind: 'text', text });
      run.emit({
        kind: 'usage',
        input: 1200,
        output: 300,
        costUsd: 0.42,
        sessionCostUsd: 0.42,
        scope: 'reply',
      });
      run.finish('complete');
    },
    { runId, text },
  );
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
const worktreeCalls = (page: Page) =>
  page.evaluate(() => (window as any).worktreeCalls ?? []) as Promise<
    { command: string; [key: string]: unknown }[]
  >;
const requests = (page: Page) =>
  page.evaluate(() => (window as any).runRequests ?? []) as Promise<
    { conversationId: string; location?: { path: string } }[]
  >;

test('the same task and model run twice side by side in worktrees of their own', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);

  // Compare mode starts with the toolbar's choice once; Add runs it once more.
  await compare(page).click();
  await expect(compare(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(runsPicker(page)).toContainText('1 run');
  await composer(page).fill('Fix the parser');
  await send(page).click();
  await expect(page.getByText('Add another run.')).toBeVisible();
  expect(await worktreeCalls(page)).toEqual([]);
  await runsPicker(page).locator('.compare-add').click();
  await expect(runsPicker(page)).toContainText('×2');
  await expect(runsPicker(page)).toContainText('2 runs');
  await send(page).click();

  // The computer makes a worktree for each run from one snapshot, and each run works in its own.
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const [create] = await worktreeCalls(page);
  expect(create).toMatchObject({ command: 'create_comparison_worktrees', count: 2 });
  expect(create.path).toMatch(/studio/);
  const sent = await requests(page);
  expect(sent).toHaveLength(2);
  const paths = sent.map((request) => request.location?.path);
  expect(new Set(paths).size).toBe(2);
  for (const path of paths) expect(path).toMatch(/worktrees\\[0-9a-f]{8}-[12]\\studio$/);

  // The comparison takes the chat's place: a column per run, numbered as they repeat.
  await expect(comparison(page)).toBeVisible();
  await expect(columns(page)).toHaveCount(2);
  await expect(columns(page).nth(0)).toContainText('#1');
  await expect(columns(page).nth(1)).toContainText('#2');
  await expect(comparison(page).locator('.comparison-task')).toContainText('Fix the parser');
  await expect(columns(page).nth(0).locator('.run-status')).toHaveText('Running');

  // The sidebar lists the comparison once.
  const rows = page.locator('#conversation-panel-active .conversation-item');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('aria-label', /comparison of 2 runs/);
  await expect(rows.first().locator('.conversation-running')).toBeVisible();

  const [first, second] = await heldRuns(page);
  await finish(page, first.runId, 'First answer');
  await expect(columns(page).nth(0)).toContainText('First answer');
  await expect(columns(page).nth(0).locator('.run-status')).toHaveText('Done');
  // One run still runs, so the comparison does too.
  await expect(rows.first().locator('.conversation-running')).toBeVisible();
  await finish(page, second.runId, 'Second answer');
  await expect(columns(page).nth(1)).toContainText('Second answer');
  await expect(rows.first().locator('.conversation-running')).toHaveCount(0);
  await expect(columns(page).nth(1).locator('.run-metrics')).toContainText('1.5K');
  await expect(columns(page).nth(1).locator('.run-metrics')).toContainText('$0.42');
  await page.screenshot({ path: 'artifacts/comparison-browser.png' });

  // Pick the second run, then apply its changes to the folder.
  await columns(page).nth(1).getByRole('button', { name: 'Pick', exact: true }).click();
  await expect(columns(page).nth(1).getByRole('button', { name: 'Picked' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(async () => (await saved(page)).comparisons?.[0]?.picked)
    .toBe(second.conversationId);
  await comparison(page).getByRole('button', { name: 'Apply to folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply to folder' });
  await expect(dialog.getByRole('list', { name: 'Files to change' })).toContainText('src/new.ts');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(comparison(page).getByText('Applied')).toBeVisible();
  const applied = (await worktreeCalls(page)).filter(
    (call) => call.command === 'comparison_changes' && call.apply,
  );
  expect(applied).toEqual([expect.objectContaining({ run: 1, apply: true })]);

  // A run opens as a chat of its own, which leads back to the comparison.
  await columns(page).nth(0).getByRole('button', { name: 'Open chat' }).click();
  await expect(comparison(page)).toHaveCount(0);
  await expect(page.getByRole('note').filter({ hasText: 'Run 1 of 2' })).toBeVisible();
  await expect(page.getByTestId('message').last()).toContainText('First answer');
  await page.getByRole('button', { name: 'Back to comparison' }).click();
  await expect(columns(page)).toHaveCount(2);

  // Deleting the comparison's row deletes every run and removes the worktrees.
  await rows.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(rows).toHaveCount(0);
  await expect
    .poll(async () => {
      const workspace = await saved(page);
      return [workspace.conversations.length, workspace.comparisons?.length ?? 0];
    })
    .toEqual([0, 0]);
  await expect
    .poll(async () =>
      (await worktreeCalls(page)).some((call) => call.command === 'remove_comparison_worktrees'),
    )
    .toBe(true);
});

test('Standalone runs one at a time start each after the one before it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  // A folder first, then Standalone, as a new chat chooses it.
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Standalone', exact: true }).click();
  await compare(page).click();
  await runsPicker(page)
    .getByRole('button', { name: /One run more/ })
    .click();
  await runsPicker(page)
    .getByRole('button', { name: /One run more/ })
    .click();
  await expect(runsPicker(page)).toContainText('3 runs');
  await runsPicker(page).getByLabel('One at a time').check();
  await composer(page).fill('Model a lantern');
  await send(page).click();

  // No worktrees without a folder: each run gets a Standalone folder of its own.
  await expect(comparison(page)).toBeVisible();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  expect(await worktreeCalls(page)).toEqual([]);
  await expect(columns(page)).toHaveCount(3);
  await expect(columns(page).nth(1).locator('.run-status')).toHaveText('Waiting');
  await expect(comparison(page)).toContainText('One at a time');

  const [first] = await heldRuns(page);
  await finish(page, first.runId, 'Lantern one');
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  await expect(columns(page).nth(1).locator('.run-status')).toHaveText('Running');
  await expect(columns(page).nth(2).locator('.run-status')).toHaveText('Waiting');

  // Start now starts a waiting run at once.
  await columns(page).nth(2).getByRole('button', { name: 'Start now' }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(3);
  const sent = await requests(page);
  expect(sent.every((request) => !request.location?.path)).toBe(true);
  // Each run is a chat of its own.
  expect(new Set(sent.map((request) => request.conversationId)).size).toBe(3);
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(1);
});

test('a folder that cannot make worktrees keeps the draft and starts nothing', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.evaluate(() =>
    localStorage.setItem('test-worktree-error', 'Compare needs a git repository, or Standalone.'),
  );
  await compare(page).click();
  await runsPicker(page).locator('.compare-add').click();
  await composer(page).fill('Fix the parser');
  await send(page).click();
  await expect(page.getByText('Compare needs a git repository, or Standalone.')).toBeVisible();
  await expect(composer(page)).toHaveValue('Fix the parser');
  await expect(runsPicker(page)).toContainText('2 runs');
  expect(await heldRuns(page)).toEqual([]);
  expect((await saved(page)).conversations).toHaveLength(0);

  // Turning Compare off sends an ordinary chat again.
  await compare(page).click();
  await expect(runsPicker(page)).toHaveCount(0);
});
