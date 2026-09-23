import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { initialWorkspace, settingsFor } from '../src/lib/domain';

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} chat spend survives history, preserves drafts and stays readable on mobile`, async ({
    page,
  }) => {
    await mockDesktop(page);
    const workspace = initialWorkspace();
    const now = new Date().toISOString(),
      runId = crypto.randomUUID();
    const settings = { ...settingsFor(workspace.preferences), provider };
    const point = {
      checkedAt: 100,
      windows: [{ id: 'weekly', label: 'Weekly', resetsAt: 1000, usedPercent: 10 }],
      balance: null,
      extraUsed: null,
      currency: null,
    };
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Session spend fixture',
      settings,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          status: 'complete',
          createdAt: now,
          blocks: [{ type: 'markdown', text: 'Check usage' }],
        },
        {
          id: crypto.randomUUID(),
          runId,
          role: 'assistant',
          status: 'complete',
          createdAt: now,
          durationMs: 2000,
          settings,
          blocks: [{ type: 'markdown', text: 'Recorded reply' }],
          usage: {
            input: 12500,
            output: 250,
            costUsd: 0.125,
            scope: 'reply' as const,
            ...(provider === 'codex' ? { sessionCredits: 2.5, sessionCostUsd: 0.125 } : {}),
          },
          accountUsage: {
            version: 1,
            revision: 2,
            runId,
            before: point,
            after: {
              ...point,
              checkedAt: 110,
              windows: [{ ...point.windows[0], usedPercent: 12 }],
            },
          },
        },
      ],
    });
    await page.addInitScript(
      (w) => localStorage.setItem('test-workspace', JSON.stringify(w)),
      workspace,
    );
    await page.goto('/');
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Session spend fixture', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
    await page.getByRole('button', { name: /Show context usage details/ }).click();
    const card = page.getByRole('region', { name: 'Chat usage and spend' });
    await expect(card).toContainText('12,500');
    await expect(card).toContainText('$0.125');
    if (provider === 'codex') await expect(card).toContainText('2.5');
    await card.getByText('Account changes during this reply', { exact: true }).click();
    await expect(card).toContainText('+2 percentage points');
    await expect(card).toContainText('Shared account observations');
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `artifacts/credits/session-${provider}-mobile.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
    await page.getByRole('button', { name: 'Reply usage and cost', exact: true }).click();
    const footer = page.locator('.reply-usage');
    await expect(footer).toContainText(
      provider === 'codex' ? 'Estimated chat credits' : 'Estimated cost (USD)',
    );
    await expect(
      footer.getByText('Account changes during this reply', { exact: true }),
    ).toBeVisible();
  });
}

test('older Claude replies label saved running cost totals and leave them out of the chat total', async ({
  page,
}) => {
  await mockDesktop(page);
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const settings = { ...settingsFor(workspace.preferences), provider: 'claude' as const };
  const answer = (text: string, usage: Record<string, unknown>) => ({
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant' as const,
    status: 'complete' as const,
    createdAt: now,
    durationMs: 1000,
    settings,
    blocks: [{ type: 'markdown' as const, text }],
    usage,
  });
  const ask = (text: string) => ({
    id: crypto.randomUUID(),
    role: 'user' as const,
    status: 'complete' as const,
    createdAt: now,
    blocks: [{ type: 'markdown' as const, text }],
  });
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Running total fixture',
    settings,
    createdAt: now,
    updatedAt: now,
    messages: [
      ask('First'),
      answer('Older reply', { input: 100, output: 10, costUsd: 0.4 }),
      ask('Second'),
      answer('New reply', { input: 50, output: 5, costUsd: 0.05, scope: 'reply' }),
    ],
  });
  await page.addInitScript(
    (w) => localStorage.setItem('test-workspace', JSON.stringify(w)),
    workspace,
  );
  await page.goto('/');
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: 'Running total fixture', exact: true }).click();
  await page.getByRole('button', { name: /Show context usage details/ }).click();
  const card = page.getByRole('region', { name: 'Chat usage and spend' });
  await expect(card).toContainText('$0.05');
  await expect(card).not.toContainText('$0.45');
  await expect(card).toContainText('that reading is excluded');
  await page.keyboard.press('Escape');
  const toggles = page.getByRole('button', { name: 'Reply usage and cost', exact: true });
  await toggles.first().click();
  const older = page.locator('.reply-usage').first();
  await expect(older).toContainText('Chat cost so far (USD)');
  await expect(older).toContainText('$0.40');
  await expect(older).toContainText('not an additional charge');
  await toggles.last().click();
  await expect(page.locator('.reply-usage').last()).toContainText('Estimated cost (USD)');
});
