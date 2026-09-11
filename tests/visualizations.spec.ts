import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';
import {
  explanationBefore,
  explanationAfter,
  explanationSource,
} from '../scripts/visualization-example.mjs';

test('visual explanations flow between paragraphs with matching typography and responsive content height', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Explain how parallel work saves time');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(
    ({ source, before, after }) => {
      (window as any).emitCapability({
        kind: 'visualization',
        visualization: { id: 'parallel', title: 'Parallel work', revision: 1, source },
      });
      (window as any).emitCapability({
        kind: 'text',
        text: before + '\n\n<!-- visualize:parallel -->\n\n' + after,
      });
      (window as any).finishCapabilities('complete');
    },
    { source: explanationSource, before: explanationBefore, after: explanationAfter },
  );
  const frame = page.frameLocator('iframe[title="Parallel work visualization"]');
  const iframe = page.locator('iframe[title="Parallel work visualization"]');
  await expect(frame.locator('#duration')).toHaveText('8 seconds');
  await frame.locator('body').evaluate(() => document.fonts.ready);
  const proseStyle = await page
    .locator('.message:not(.user) .prose')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, font: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight };
    });
  expect(
    await frame.locator('body').evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, font: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight };
    }),
  ).toEqual(proseStyle);
  expect(
    await frame.locator('body').evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      padding: getComputedStyle(el).padding,
      fontLoaded: document.fonts.check('13px "DM Sans Variable"'),
    })),
  ).toEqual({ background: 'rgba(0, 0, 0, 0)', padding: '0px', fontLoaded: true });
  await expect.poll(async () => (await iframe.boundingBox())!.height).toBeGreaterThan(190);
  const originalHeight = (await iframe.boundingBox())!.height;
  expect(originalHeight).toBeLessThan(320);
  const before = page.locator('.prose').filter({ hasText: 'Twelve independent jobs' });
  const after = page.locator('.prose').filter({ hasText: 'With three workers' });
  expect((await before.boundingBox())!.y).toBeLessThan((await iframe.boundingBox())!.y);
  expect((await after.boundingBox())!.y).toBeGreaterThan(
    (await iframe.boundingBox())!.y + originalHeight,
  );
  await frame.getByLabel('Workers', { exact: true }).fill('6');
  await expect(frame.locator('#duration')).toHaveText('4 seconds');
  await expect
    .poll(async () => (await iframe.boundingBox())!.height)
    .toBeGreaterThan(originalHeight + 60);
  await frame.getByLabel('Workers', { exact: true }).fill('3');
  await expect.poll(async () => (await iframe.boundingBox())!.height).toBe(originalHeight);
  await frame.getByText('Why this works', { exact: true }).click();
  await expect
    .poll(async () => (await iframe.boundingBox())!.height)
    .toBeGreaterThan(originalHeight);
  await frame.getByText('Why this works', { exact: true }).click();
  await expect.poll(async () => (await iframe.boundingBox())!.height).toBe(originalHeight);
  // A sibling/parent or a child with an unrecognized token cannot resize this frame.
  await page.evaluate(() =>
    window.postMessage({ type: 'studio-visualization-size', token: 'forged', height: 1600 }, '*'),
  );
  await frame
    .locator('body')
    .evaluate(() =>
      parent.postMessage({ type: 'studio-visualization-size', token: 'forged', height: 1600 }, '*'),
    );
  await expect(iframe).toHaveCSS('height', `${originalHeight}px`);
  await after.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/visualize-flow-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await iframe.scrollIntoViewIfNeeded();
  await expect(frame.locator('#duration')).toHaveText('8 seconds');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/visualize-flow-mobile.png' });
});

test('tool visuals render inline, update by revision, persist, expand and remain isolated on mobile', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Visualize a counter');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const source =
    "<h2>Interactive counter</h2><button onclick=\"document.querySelector('output').textContent=Number(document.querySelector('output').textContent)+1\">Add one</button><output>0</output>";
  const visual = { id: 'counter', title: 'Interactive counter', revision: 1, source };
  await page.evaluate(
    (visualization) => (window as any).emitCapability({ kind: 'visualization', visualization }),
    visual,
  );
  const frame = page.frameLocator('iframe[title="Interactive counter visualization"]');
  await frame.getByRole('button', { name: 'Add one' }).click();
  await expect(frame.locator('output')).toHaveText('1');
  const boundaries = await frame.locator('body').evaluate(async () => {
    let parentBlocked = false,
      storageBlocked = false,
      networkBlocked = false;
    try {
      void parent.document.body;
    } catch {
      parentBlocked = true;
    }
    try {
      localStorage.setItem('leak', 'x');
    } catch {
      storageBlocked = true;
    }
    try {
      await fetch('/v1/state');
    } catch {
      networkBlocked = true;
    }
    return {
      parentBlocked,
      storageBlocked,
      networkBlocked,
      noBridge: !(window as any).__TAURI_INTERNALS__,
    };
  });
  expect(boundaries).toEqual({
    parentBlocked: true,
    storageBlocked: true,
    networkBlocked: true,
    noBridge: true,
  });
  await page.getByRole('button', { name: 'Expand Interactive counter', exact: true }).click();
  const expanded = page.frameLocator('iframe[title="Interactive counter preview"]');
  await expect(page.getByRole('tabpanel', { name: 'Artifact preview' })).toHaveCSS(
    'background-color',
    'rgb(20, 22, 21)',
  );
  await expect(expanded.locator('output')).toHaveText('0');
  await page.evaluate((visualization) => {
    (window as any).emitCapability({
      kind: 'visualization',
      visualization: {
        ...visualization,
        revision: 2,
        source: visualization.source.replace('<output>0', '<output>10'),
      },
    });
    (window as any).emitCapability({ kind: 'visualization', visualization });
    (window as any).emitCapability({ kind: 'text', text: 'Explore the counter.' });
    (window as any).finishCapabilities('complete');
  }, visual);
  await expect(expanded.locator('output')).toHaveText('10');
  await page.getByRole('button', { name: 'Close artifact' }).click();
  await expect(frame.locator('output')).toHaveText('10');
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Expand Interactive counter', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Interactive counter' });
  await modal.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(modal.locator('code')).toHaveText(source.replace('<output>0', '<output>10'));
  await page.getByRole('button', { name: 'Close artifact' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.getByRole('button', { name: 'Add one' }).click();
  await expect(frame.locator('output')).toHaveText('11');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/visualize-mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.screenshot({ path: 'artifacts/visualize-desktop.png' });
});

test('the production PWA restores multiple saved visuals and downloads their exact source', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-visual-web-'));
  const token = 'synthetic-visualization-fixture-pairing-key';
  const server = createRelay({
    token,
    directory,
    webDirectory: resolve('build'),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  const source =
    '<button onclick="document.querySelector(\'output\').textContent=1">Add one</button><output>0</output>';
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'PWA visual history',
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
            type: 'markdown',
            text: '[Before][docs]\n\n```text\n<!-- visualize:one -->\n```\n\n> <!-- visualize:two -->\n\n<!-- visualize:unknown -->\n\n<!-- visualize:one -->\n\n[After][docs]\n\n<!-- visualize:one -->\n\n[docs]: https://example.com/guide',
          },
        ],
        visualizations: [
          { id: 'one', title: 'First visual', revision: 2, source },
          { id: 'two', title: 'Second visual', revision: 1, source: '<p>Second visual</p>' },
        ],
      },
    ],
  });
  try {
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: /PWA visual history/ }).click();
    const frame = page.frameLocator('iframe[title="First visual visualization"]');
    await frame.getByRole('button', { name: 'Add one' }).click();
    await expect(frame.locator('output')).toHaveText('1');
    await expect(page.locator('.prose pre code')).toHaveText('<!-- visualize:one -->');
    await expect(page.getByRole('link', { name: 'Before', exact: true })).toHaveAttribute(
      'href',
      'https://example.com/guide',
    );
    await expect(page.getByRole('link', { name: 'After', exact: true })).toHaveAttribute(
      'href',
      'https://example.com/guide',
    );
    const order = await page
      .locator('.message-content > .prose, .message-content > .visualization')
      .evaluateAll((els) =>
        els.map((el) =>
          el.matches('.visualization') ? el.getAttribute('aria-label') : el.textContent?.trim(),
        ),
      );
    expect(order[0]).toContain('Before');
    expect(order.slice(1)).toEqual(['First visual', 'After', 'Second visual']);
    await expect(
      page.frameLocator('iframe[title="Second visual visualization"]').getByText('Second visual'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Expand First visual' }).click();
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    expect(
      await page.getByRole('tabpanel', { name: 'Artifact source' }).locator('code').textContent(),
    ).toBe(source);
    const received = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await received;
    expect(readFileSync((await download.path())!, 'utf8')).toBe(source);
    await page.getByRole('button', { name: 'Close artifact' }).click();
    await page.reload();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: /PWA visual history/ }).click();
    await expect(frame.locator('output')).toHaveText('0');
    await expect(page.locator('iframe')).toHaveCount(2);
    await page.screenshot({ path: 'artifacts/visualize-pwa.png' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
