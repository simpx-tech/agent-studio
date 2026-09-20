import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function start(page: Page, claude = false) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  if (claude) {
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page
      .getByRole('option', { name: /Claude/ })
      .first()
      .click();
  }
  await page.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('option', { name: /^Plan/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('Plan a small change');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Mode', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-last-request')!).agent.planMode,
    ),
  ).toBe(true);
}
async function approval(page: Page, action: 'enter' | 'exit') {
  await page.evaluate((action) => {
    const w = window as any;
    w.testQuestion = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'approval',
          header: 'Plan mode',
          question: 'Approve?',
          options: [
            { label: 'Approve', description: '' },
            { label: 'Decline', description: '' },
          ],
          multiSelect: false,
        },
      ],
      planApproval: {
        action,
        ...(action === 'exit'
          ? {
              text: '# Implementation proposal\n\n1. Add a greeting.\n2. Verify the result.\n\n<script>window.planExecuted=true</script>',
            }
          : {}),
      },
    };
    w.emitCapability({ kind: 'question', question: w.testQuestion });
  }, action);
}
test('Claude entry and implementation require explicit decisions, retain drafts and recover from delivery failure', async ({
  page,
}) => {
  await start(page, true);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Preserved draft');
  await approval(page, 'enter');
  await expect(page.getByRole('button', { name: 'Enter plan mode', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).answersSent ?? [])).toEqual([]);
  await page.getByRole('button', { name: 'Enter plan mode', exact: true }).click();
  await expect(page.getByLabel('Plan mode approval')).toContainText('entry approved');
  await approval(page, 'exit');
  await expect(page.getByLabel('Proposed plan')).toContainText('Implementation proposal');
  await page.evaluate(() => ((window as any).answerFailure = true));
  await page.getByRole('button', { name: 'Approve and implement' }).click();
  await expect(page.getByRole('alert')).toContainText('offline');
  await expect(input).toHaveValue('Preserved draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Keep planning' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/plan-mode/browser-approval-mobile.png' });
  await page.evaluate(() => ((window as any).answerFailure = false));
  await page.getByRole('button', { name: 'Keep planning' }).click();
  expect(
    await page.evaluate(() => (window as any).answersSent.at(-1).answer.answers[0].values),
  ).toEqual(['Decline']);
  expect(await page.evaluate(() => (window as any).planExecuted)).toBeUndefined();
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'I will keep planning.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.getByLabel('Proposed plan')).toContainText('Implementation proposal');
  await expect(page.getByRole('button', { name: 'Approve and implement' })).toHaveCount(0);
});
test('Codex proposals are separate from TODOs, final text replaces deltas, and completed plans survive reload', async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({
      kind: 'plan',
      plan: { revision: 1, steps: [{ id: 'step', title: 'Research progress', status: 'running' }] },
    });
    w.emitCapability({
      kind: 'proposedplan',
      proposedPlan: { id: 'p', revision: 1, text: 'Old draft', complete: false, truncated: false },
    });
  });
  await expect(page.getByLabel('Proposed plan')).toContainText('Drafting plan');
  await expect(page.getByLabel('Proposed plan')).not.toContainText('Research progress');
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({
      kind: 'proposedplan',
      proposedPlan: {
        id: 'p',
        revision: 2,
        text: '# Final proposal\n\nAdd the feature and verify it.',
        complete: true,
        truncated: false,
      },
    });
    w.emitCapability({
      kind: 'proposedplan',
      proposedPlan: { id: 'p', revision: 3, text: 'Late draft', complete: false, truncated: false },
    });
    w.finishCapabilities('complete');
  });
  await expect(page.getByLabel('Proposed plan')).toContainText('Final proposal');
  await expect(page.getByLabel('Proposed plan')).not.toContainText('Late draft');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/plan-mode/browser-proposal-desktop.png' });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.getByLabel('Proposed plan')).toContainText('Final proposal');
  await expect(page.getByRole('combobox', { name: 'Mode', exact: true })).toContainText('Plan');
});
test('Stop closes plan approval and shows partial proposed plans as unconfirmed', async ({
  page,
}) => {
  await start(page, true);
  await approval(page, 'exit');
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'proposedplan',
      proposedPlan: { id: 'p', revision: 1, text: 'Partial', complete: false, truncated: false },
    }),
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Approve and implement' })).toHaveCount(0);
  await expect(page.getByLabel('Plan mode approval')).toContainText('no longer available');
  await expect(page.getByText('Plan was not completed.', { exact: true })).toBeVisible();
});
