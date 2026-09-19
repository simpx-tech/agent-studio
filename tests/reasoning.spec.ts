import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

for (const status of ['complete', 'cancelled', 'error'] as const)
  test(`reasoning streams separately and survives ${status} and reload`, async ({ page }) => {
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill(`Reasoning ${status} fixture`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const panel = page.locator('.reasoning-panel');
    await expect(panel).toHaveCount(0);
    const reasoning = {
      kind: 'reasoning',
      id: 'r1',
      revision: 1,
      text: 'Compare **options**.',
      truncated: false,
    };
    await emit(reasoning);
    await expect(panel).not.toHaveAttribute('open', '');
    await panel.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(panel.locator('strong')).toHaveText('options');
    await page.getByLabel('Message', { exact: true }).fill('Draft stays intact');
    await emit({
      ...reasoning,
      revision: 3,
      text: 'Compare **options**.\n\n```ts\nconst choice = 2;\n```\n<script>window.reasoningUnsafe = true</script><img src=x onerror="window.reasoningUnsafe=true">',
    });
    await emit({ ...reasoning, revision: 2, text: 'STALE' });
    await emit({ ...reasoning, id: 'r2', text: 'Second reasoning item.', truncated: true });
    await expect(panel).toHaveAttribute('open', '');
    await expect(panel.locator('.reasoning-text')).toHaveCount(2);
    await expect(panel).not.toContainText('STALE');
    await expect(panel.locator('code .hljs-keyword')).toHaveText('const');
    await expect(panel.locator('script, img, [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reasoningUnsafe)).toBeUndefined();
    await expect(panel).toContainText('This section is incomplete');
    await expect(page.locator('.response-artifacts')).toHaveCount(0);
    await emit({ kind: 'text', text: 'The answer is 2.' });
    await page.evaluate((status) => (window as any).finishCapabilities(status), status);
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      'data-status',
      status,
    );
    await expect(page.locator('.message-content > .prose')).toHaveText('The answer is 2.');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Draft stays intact');
    await page.screenshot({ path: `artifacts/reasoning-${status}-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `artifacts/reasoning-${status}-mobile.png` });
    await page.setViewportSize({ width: 1380, height: 900 });
    await page.reload();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: new RegExp(`Reasoning ${status} fixture`) }).click();
    await expect(panel).not.toHaveAttribute('open', '');
    await panel.locator('summary').click();
    await expect(panel.locator('.reasoning-text')).toHaveCount(2);
    await expect(panel).toContainText('Compare options.');
    await expect(panel).not.toContainText('STALE');
  });

test('production PWA restores reasoning from a real relay workspace', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-reasoning-pwa-'));
  const token = 'synthetic-reasoning-fixture-pairing-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Relay reasoning fixture',
    archived: true,
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        blocks: [
          {
            type: 'reasoning',
            id: 'msg:0',
            revision: 3,
            text: 'Provider reasoning through the relay.',
            truncated: false,
          },
          { type: 'markdown', text: 'Saved answer.' },
        ],
      },
    ],
  });
  try {
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: /Relay reasoning fixture/ }).click();
    await expect(page.locator('.reasoning-panel')).not.toHaveAttribute('open', '');
    await page.locator('.reasoning-panel > summary').click();
    await expect(page.locator('.reasoning-text')).toHaveText(
      'Provider reasoning through the relay.',
    );
    await expect(page.locator('.message-content > .prose')).toHaveText('Saved answer.');
    await page.screenshot({ path: 'artifacts/reasoning-pwa.png' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
