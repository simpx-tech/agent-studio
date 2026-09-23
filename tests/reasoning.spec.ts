import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

// Each timeline row: reasoning, a tool group summary, or a comment/note.
const timeline = (page: Page) =>
  page
    .locator('.message')
    .last()
    .locator('.activity-timeline')
    .evaluate((el) =>
      [...el.children].map((child) =>
        child.classList.contains('reasoning-entry')
          ? `Reasoning: ${child.querySelector('p')?.textContent?.trim()}`
          : (child.querySelector(':scope > summary') ?? child).textContent
              ?.replace(/\s+/g, ' ')
              .trim(),
      ),
    );

for (const status of ['complete', 'cancelled', 'error'] as const)
  test(`reasoning streams inside the work timeline and survives ${status} and reload`, async ({
    page,
  }) => {
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill(`Reasoning ${status} fixture`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const tool = (id: string, name: string, operation: string) => ({
      kind: 'tool',
      tool: {
        id,
        name,
        operation,
        category: 'tool',
        revision: 1,
        status: 'complete',
        sources: [],
        agents: [],
      },
    });
    const entries = page.locator('.reasoning-entry');
    await emit({ kind: 'progress', id: 'p1', revision: 1, text: 'I will compare the options.' });
    await emit(tool('read1', 'Read', 'read'));
    await expect(entries).toHaveCount(0);
    const reasoning = {
      kind: 'reasoning',
      id: 'r1',
      revision: 1,
      text: 'Compare **options**.',
      truncated: false,
    };
    await emit(reasoning);
    // Live reasoning is readable in place, without opening another disclosure.
    await expect(entries.locator('strong')).toHaveText('options');
    await expect(entries).toHaveAttribute('aria-label', 'Reasoning');
    await expect(page.locator('.reasoning-panel')).toHaveCount(0);
    await page.getByLabel('Message', { exact: true }).fill('Draft stays intact');
    await emit({
      ...reasoning,
      revision: 3,
      text: 'Compare **options**.\n\n```ts\nconst choice = 2;\n```\n<script>window.reasoningUnsafe = true</script><img src=x onerror="window.reasoningUnsafe=true">',
    });
    await emit({ ...reasoning, revision: 2, text: 'STALE' });
    await emit(tool('run1', 'Run command', 'command'));
    await emit({ ...reasoning, id: 'r2', text: 'Second reasoning item.', truncated: true });
    const sequence = [
      'Connected',
      'I will compare the options.',
      'Read files',
      'Reasoning: Compare options.',
      'Ran commands',
      'Reasoning: Second reasoning item.',
    ];
    await expect.poll(() => timeline(page)).toEqual(sequence);
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).not.toContainText('STALE');
    await expect(entries.first().locator('code .hljs-keyword')).toHaveText('const');
    await expect(entries.locator('script, img, [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reasoningUnsafe)).toBeUndefined();
    await expect(entries.last()).toContainText('This section is incomplete');
    await expect(page.locator('.response-artifacts')).toHaveCount(0);
    await page.screenshot({ path: `artifacts/reasoning-${status}-running.png` });
    await emit({ kind: 'text', text: 'The answer is 2.' });
    await page.evaluate((status) => (window as any).finishCapabilities(status), status);
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      'data-status',
      status,
    );
    await expect(page.locator('.message-content > .prose')).toHaveText('The answer is 2.');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Draft stays intact');
    const history = page.locator('.activity-summary');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(entries.first()).not.toBeVisible();
    await page.getByLabel('Work history', { exact: true }).click();
    await expect(entries.first()).toBeVisible();
    expect(await timeline(page)).toEqual(sequence);
    await page.screenshot({ path: `artifacts/reasoning-${status}-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `artifacts/reasoning-${status}-mobile.png` });
    await page.setViewportSize({ width: 1380, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe(status);
    await page.reload();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: new RegExp(`Reasoning ${status} fixture`) }).click();
    await expect(history).not.toHaveAttribute('open', '');
    await page.getByLabel('Work history', { exact: true }).click();
    expect(await timeline(page)).toEqual(sequence);
    await expect(entries.first()).toContainText('Compare options.');
    await expect(entries.first()).not.toContainText('STALE');
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
            id: 'msg:1',
            revision: 3,
            text: 'Provider reasoning through the relay.',
            truncated: false,
          },
          // Older hosts saved the same Claude thinking block again from its snapshot.
          {
            type: 'reasoning',
            id: 'msg:0',
            revision: 1,
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
    await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
    await page.getByLabel('Work history', { exact: true }).click();
    await expect(page.locator('.reasoning-entry')).toHaveCount(1);
    await expect(page.locator('.reasoning-entry')).toHaveText(
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
