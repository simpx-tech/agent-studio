import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

test('authenticated production Viewer restores final diffs and distinguishes missing history', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-file-changes-web-'));
  const token = 'synthetic-file-changes-fixture-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Viewer file changes',
    archived: true,
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'Older reply.' }],
      },
      ...[
        ['original', 'middle'],
        ['middle', 'final'],
      ].map(([before, after]) => ({
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        status: 'complete' as const,
        createdAt: now,
        blocks: [{ type: 'markdown' as const, text: 'Updated the source.' }],
        fileChanges: {
          revision: 2,
          limited: false,
          edits: [
            {
              id: 'one',
              files: [
                {
                  path: 'src/example.ts',
                  kind: 'modified' as const,
                  hunks: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ['-' + before, '+' + after],
                    },
                  ],
                },
              ],
            },
          ],
        },
      })),
    ],
  });
  try {
    await seedAndPairPwa(page, url, token, workspace);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('tab', { name: /^History/ }).click();
      await page.getByRole('button', { name: /Viewer file changes/ }).click();
      const last = page.locator('.file-changes').last();
      await expect(last).toHaveAttribute('open', '');
      await last.getByRole('tab', { name: 'All chat changes', exact: true }).click();
      await last.locator('.changed-file > summary').click();
      await expect(last.locator('.diff-code')).toHaveText(['-original', '+final']);
      const old = page.locator('.file-changes').first();
      await expect(old).toHaveAttribute('open', '');
      await expect(
        old.getByText('File changes were not recorded for this response.', { exact: true }),
      ).toBeVisible();
      if (!attempt) await page.reload();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mobile of [false, true])
  test(`reply and cumulative file diffs survive reload ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    for (const [before, after] of [
      ['original', 'intermediate'],
      ['intermediate', '<script>final</script>'],
    ]) {
      await page.getByLabel('Message', { exact: true }).fill('Update the fixture');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
      await page.evaluate(
        ({ before, after }) => {
          (window as any).emitCapability({
            kind: 'filechanges',
            fileChanges: {
              revision: 1,
              limited: false,
              edits: [
                {
                  id: 'edit-1',
                  files: [
                    {
                      path: 'C:\\Projects\\studio\\src\\components\\Example.svelte',
                      kind: 'modified',
                      hunks: [
                        {
                          oldStart: 1,
                          oldLines: 1,
                          newStart: 1,
                          newLines: 1,
                          lines: ['-' + before, '+' + after],
                        },
                      ],
                    },
                    {
                      path: 'C:\\Projects\\studio\\docs\\new.txt',
                      kind: before === 'original' ? 'added' : 'modified',
                      hunks: [
                        {
                          oldStart: before === 'original' ? 0 : 1,
                          oldLines: before === 'original' ? 0 : 1,
                          newStart: 1,
                          newLines: 1,
                          lines:
                            before === 'original'
                              ? ['+new document']
                              : ['-new document', '+final document'],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          });
          (window as any).emitCapability({ kind: 'text', text: 'The fixture has been updated.' });
          (window as any).finishCapabilities('complete');
        },
        { before, after },
      );
      await expect(page.locator('.message[data-status="running"]')).toHaveCount(0);
    }
    await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
    const summary = page.locator('.file-changes').last();
    await expect(summary).toHaveAttribute('open', '');
    await summary.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(summary).not.toHaveAttribute('open', '');
    await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('open', '');
    const file = summary
      .locator('.changed-file')
      .filter({ hasText: 'src/components/Example.svelte' });
    await expect(file).toHaveCount(1);
    await expect(file.locator('.file-path')).toHaveText('src/components/Example.svelte');
    await expect(file.locator('summary')).toHaveAttribute(
      'title',
      'C:\\Projects\\studio\\src\\components\\Example.svelte',
    );
    await expect(file.locator('.file-kind')).toHaveText('Edited');
    expect(
      await file.evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth)),
    ).toBeGreaterThan(0);
    await expect(file).not.toHaveAttribute('open', '');
    await file.locator('summary').click();
    await expect(summary.locator('.changed-file[open] .diff-code')).toHaveText([
      '-intermediate',
      '+<script>final</script>',
    ]);
    await expect(summary.locator('script')).toHaveCount(0);
    await summary.getByRole('tab', { name: 'This response', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(summary.getByRole('tab', { name: 'All chat changes', exact: true })).toBeFocused();
    await expect(
      summary.locator('.changed-file').filter({ hasText: 'docs/new.txt' }).locator('.file-kind'),
    ).toHaveText('Added');
    await file.locator('summary').click();
    await expect(summary.locator('.changed-file[open] .diff-code')).toHaveText([
      '-original',
      '+<script>final</script>',
    ]);
    await expect(summary.locator('.change-totals')).toContainText('+1');
    const newFile = summary.locator('.changed-file').filter({ hasText: 'docs/new.txt' });
    await expect(newFile.locator('summary .add, summary .remove')).toHaveCount(0);
    await newFile.locator('summary').click();
    await expect(newFile.locator('.hunk')).toHaveCount(0);
    await expect(newFile.locator('.diff-code')).toHaveText('+final document');
    await expect(file.locator('.hunk')).toHaveCount(1);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
    expect(await summary.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/file-changes-${mobile ? 'mobile' : 'desktop'}.png` });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.filter(
              (m: any) => m.role === 'assistant',
            ).length,
        ),
      )
      .toBe(2);
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await expect(page.locator('.file-changes')).toHaveCount(2);
    const first = page.locator('.file-changes').first();
    await expect(first).toHaveAttribute('open', '');
    await first.getByRole('tab', { name: 'All chat changes', exact: true }).click();
    await first
      .locator('.changed-file')
      .filter({ hasText: 'src/components/Example.svelte' })
      .locator('summary')
      .click();
    await expect(first.locator('.changed-file[open] .diff-code')).toHaveText([
      '-original',
      '+<script>final</script>',
    ]);
  });
