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
            ...(provider === 'codex'
              ? { scope: 'reply' as const, sessionCredits: 2.5, sessionCostUsd: 0.125 }
              : {}),
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
