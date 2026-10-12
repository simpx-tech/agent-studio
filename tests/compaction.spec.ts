import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function finish(page: Page, compact = false) {
  await page.evaluate((compact) => {
    const w = window as any;
    if (compact)
      w.emitCapability({
        kind: 'compaction',
        compaction: {
          id: 'c1',
          revision: 2,
          status: 'complete',
          trigger: 'manual',
          preTokens: 90000,
          postTokens: 6000,
        },
      });
    w.emitCapability({ kind: 'text', text: compact ? 'Context compacted.' : 'Ready' });
    w.finishCapabilities('complete');
  }, compact);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
}
test('manual compaction preserves the draft, shows progress, and survives reload on desktop and mobile', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Remember this');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await finish(page);
  await input.fill('Keep my draft');
  await page.getByRole('button', { name: /Show context usage details/ }).click();
  await page.getByRole('button', { name: 'Compact context', exact: true }).click();
  await expect(input).toHaveValue('Keep my draft');
  await expect(page.locator('.message').last()).toContainText('Compacting context');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.compact).toBe(true);
  expect(request.messages.at(-1).text).toBe('/compact');
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'compaction',
      compaction: { id: 'c1', revision: 1, status: 'running', trigger: 'manual' },
    }),
  );
  await expect(page.getByLabel('Context compaction')).toContainText('Compacting context');
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeDisabled();
  await finish(page, true);
  await expect(page.getByLabel('Context compaction')).toContainText(
    '90,000 tokens before → 6,000 after',
  );
  await page.screenshot({ path: 'artifacts/compaction/browser-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/compaction/browser-mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.getByLabel('Context compaction')).toContainText('Context compacted');
  await page.screenshot({ path: 'artifacts/compaction/browser-history.png' });
});

test('Claude sizing and slash compaction preserve arguments, while unsupported and busy requests keep drafts', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/compact');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('/compact');
  await expect(page.getByRole('alert')).toContainText('idle Claude or Codex');
  await input.fill('Start');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await finish(page);
  await page.getByRole('button', { name: /Show context usage details/ }).click();
  await page.getByRole('combobox', { name: 'Claude auto-compaction window' }).click();
  await page.getByRole('option', { name: 'Custom size…', exact: true }).click();
  await page.getByLabel('Auto-compaction tokens').fill('0');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  // Any positive size.
  await page.getByLabel('Auto-compaction tokens').fill('99999');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Close usage details' }).click();
  await input.fill('/compact Preserve the lighthouse code');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.compact).toBe(true);
  expect(request.agent.autoCompactTokens).toBe(99999);
  expect(request.messages.at(-1).text).toBe('/compact Preserve the lighthouse code');
  await input.fill('/compact');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(input).toHaveValue('/compact');
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'compaction',
      compaction: { id: 'c1', revision: 1, status: 'running', trigger: 'manual' },
    }),
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByLabel('Context compaction')).toContainText('Compaction was not confirmed');
});

for (const mobile of [false, true])
  test(`an automatic compaction is part of the reply's work, where it began ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Refactor the importer');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const tool = (id: string, operation: string, name: string, extra = {}) => ({
      kind: 'tool',
      tool: {
        id,
        operation,
        name,
        category: 'tool',
        revision: 1,
        status: 'complete',
        sources: [],
        agents: [],
        ...extra,
      },
    });
    const compaction = (revision: number, status: string, sizes = {}) => ({
      kind: 'compaction',
      compaction: { id: 'compaction-1', revision, status, trigger: 'auto', ...sizes },
    });
    const marker = page.getByLabel('Context compaction');
    const compacted = 'Context compacted automatically · 967,265 tokens before → 8,081 after';
    await emit({ kind: 'progress', id: 'plan', revision: 1, text: 'I will read the importer.' });
    await emit(tool('read1', 'read', 'Read', { path: '/fixture/importer.ts' }));
    await emit(tool('read2', 'read', 'Read', { path: '/fixture/rows.ts' }));
    await emit(compaction(1, 'running'));
    // It joins the running reply's work after the calls made so far, which fold into their group.
    await expect(marker).toHaveText('Compacting context…');
    await expect(marker.locator('.spinning')).toHaveCount(1);
    await expect(page.locator('.live-label')).toHaveText('Compacting context');
    await expect(page.locator('.activity-group > summary')).toHaveText('Read 2 files');
    await expect(page.locator('.live-row')).toHaveCount(0);
    await emit(compaction(2, 'complete', { preTokens: 967265, postTokens: 8081 }));
    await expect(marker).toHaveText(compacted);
    await expect(marker.locator('.spinning')).toHaveCount(0);
    await expect(page.locator('.live-label')).toHaveText('Responding');
    await emit(tool('edit', 'edit', 'Edit', { path: '/fixture/importer.ts' }));
    await emit(tool('run', 'command', 'Run command', { commandRun: true, command: 'npm test' }));
    // The calls after it start a group of their own below it.
    const kinds = () =>
      page
        .locator('.activity-timeline')
        .evaluate((el) => [...el.children].map((child) => child.classList[0]));
    expect(await kinds()).toEqual([
      'timeline-note',
      'prose',
      'live-group',
      'compaction-entry',
      'live-group',
    ]);
    await page.screenshot({
      path: `artifacts/compaction/automatic-running-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await emit({ kind: 'text', text: 'The importer is refactored.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    const reply = page.locator('.message[data-status="complete"]').last();
    const history = reply.locator('.activity-summary');
    // Nothing stands between the collapsed history and the answer; the marker is out of the page.
    await expect(history).not.toHaveAttribute('open', '');
    await expect(reply.locator('.message-heading + .tool-activity + .prose')).toHaveText(
      'The importer is refactored.',
    );
    await expect(marker).toHaveCount(0);
    await expect(reply.locator('.compaction-history')).toHaveCount(0);
    const sequence = () =>
      reply
        .locator('.activity-timeline')
        .evaluate((el) =>
          [...el.children].map((child) =>
            (child.querySelector(':scope > summary') ?? child).textContent
              ?.replace(/\s+/g, ' ')
              .trim(),
          ),
        );
    const recorded = [
      'Connected',
      'I will read the importer.',
      'Read 2 files',
      compacted,
      'Edited 1 file and ran 1 command',
    ];
    await reply.getByLabel('Work history', { exact: true }).click();
    expect(await sequence()).toEqual(recorded);
    expect(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/compaction/automatic-history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    const saved = () =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1),
      );
    await expect.poll(async () => (await saved()).status).toBe('complete');
    // Its place counts what the reply had recorded before it: a note, a comment and two calls.
    expect((await saved()).compactions).toMatchObject([{ status: 'complete', after: 4 }]);
    const reopen = async () => {
      await page.reload();
      if (mobile)
        await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
      await page.getByRole('tab', { name: /^History/ }).click();
      await page.locator('.conversation-item').first().click();
      await expect(reply.locator('.message-heading + .tool-activity + .prose')).toHaveText(
        'The importer is refactored.',
      );
      await expect(marker).toHaveCount(0);
      await reply.getByLabel('Work history', { exact: true }).click();
    };
    await reopen();
    expect(await sequence()).toEqual(recorded);
    // A reply saved before places were recorded keeps its marker in the history, after its work.
    // The place goes as the page loads, so no save of the page before it can put it back.
    await page.addInitScript(() => {
      const workspace = JSON.parse(localStorage.getItem('test-workspace') ?? 'null');
      for (const item of workspace?.conversations[0]?.messages.at(-1)?.compactions ?? [])
        delete item.after;
      if (workspace) localStorage.setItem('test-workspace', JSON.stringify(workspace));
    });
    await reopen();
    expect((await saved()).compactions).toMatchObject([{ status: 'complete' }]);
    expect((await saved()).compactions[0]).not.toHaveProperty('after');
    expect(await sequence()).toEqual([
      'Connected',
      'I will read the importer.',
      'Read 2 files, edited 1 file, and ran 1 command',
      compacted,
    ]);
    await expect(reply.locator('.compaction-history')).toHaveCount(0);
  });
