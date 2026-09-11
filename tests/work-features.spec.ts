import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';

test('the production PWA renders and downloads artifacts through the real relay origin', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-artifact-web-'));
  const server = createRelay({
    token: 'synthetic-artifact-fixture-pairing-key',
    directory,
    webDirectory: resolve('build'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source =
    "<!doctype html><h1>PWA Counter</h1><button onclick=\"document.querySelector('output').textContent='1'\">Add one</button><output>0</output>";
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'PWA artifact fixture',
    createdAt: now,
    updatedAt: now,
    archived: true,
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: '```html PWA Counter\n' + source + '\n```' }],
      },
    ],
  });
  try {
    await page.addInitScript((workspace) => {
      if (window.top === window)
        localStorage.setItem('agent-studio.browser.v1', JSON.stringify(workspace));
    }, workspace);
    await page.goto(url);
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: /PWA artifact fixture/ }).click();
    await page.getByRole('button', { name: 'PWA Counter Open HTML' }).click();
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Add one' }).click();
    await expect(frame.locator('output')).toHaveText('1');
    expect(await page.locator('iframe').getAttribute('src')).toBe('/artifact-preview');
    const received = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await received;
    expect(download.suggestedFilename()).toBe('PWA Counter.html');
    expect(readFileSync((await download.path())!, 'utf8')).toBe(source);
    await page.screenshot({ path: 'artifacts/artifact-preview-pwa.png' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTML artifacts execute interactively in an isolated preview and retain downloadable source', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Create an interactive artifact');
  await page.getByRole('button', { name: 'Send message' }).click();
  const source = `<!doctype html><html><head><title>Counter</title><style>body{font:20px system-ui;padding:24px;background:#e8f1ef}button{padding:12px}</style></head><body><h1>Counter</h1><button id="add">Add one</button><output id="count">0</output><p id="isolation"></p><script>
let n=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=String(++n);
let checks=[];try{parent.document.body.dataset.compromised='yes'}catch{checks.push('parent blocked')};try{localStorage.setItem('leak','x')}catch{checks.push('storage blocked')};checks.push(typeof window.__TAURI_INTERNALS__==='undefined'?'no native bridge':'bridge exposed');document.querySelector('#isolation').textContent=checks.join(', ');
fetch('/v1/state').catch(()=>{});</script></body></html>`;
  await page.evaluate((source) => {
    (window as any).emitCapability({
      kind: 'text',
      text: 'Here is the counter.\n\n```html Counter\n' + source + '\n```',
    });
    (window as any).finishCapabilities('complete');
  }, source);
  await page.getByRole('button', { name: 'Counter Open HTML' }).click();
  const viewer = page.getByRole('dialog', { name: 'Counter' });
  const frame = page.frameLocator('iframe[title="Counter preview"]');
  await expect(frame.getByRole('heading', { name: 'Counter' })).toBeVisible();
  await frame.getByRole('button', { name: 'Add one' }).click();
  await expect(frame.locator('output')).toHaveText('1');
  await expect(frame.locator('#isolation')).toHaveText(
    'parent blocked, storage blocked, no native bridge',
  );
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(viewer.locator('pre')).toHaveText(source);
  await viewer.getByRole('button', { name: 'Download', exact: true }).click();
  expect(await page.evaluate(() => (window as any).savedArtifact)).toEqual({
    source,
    filename: 'Counter.html',
    language: 'html',
  });
  await viewer.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Counter' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/artifact-preview-browser.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer.getByRole('button', { name: 'Close artifact' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/artifact-preview-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Create an interactive artifact/ }).click();
  await expect(page.getByRole('button', { name: 'Counter Open HTML' })).toBeVisible();
});

test('saved Claude workflows preserve drafts, capture the exact definition, and persist step progress', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: /Claude/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Claude workflows', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Claude workflows' });
  await manager.getByLabel('Workflow name', { exact: true }).fill('Research and review');
  await manager.getByLabel('Step 1 title', { exact: true }).fill('Research');
  await manager.getByLabel('Step 1 prompt', { exact: true }).fill('Read the supplied source');
  await manager.getByRole('button', { name: 'Add step' }).click();
  await manager.getByLabel('Step 2 title', { exact: true }).fill('Review');
  await manager.getByLabel('Step 2 prompt', { exact: true }).fill('Check the preceding result');
  await manager.getByLabel('Workflow input', { exact: true }).fill('Synthetic input');
  await manager.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await expect(manager.getByRole('button', { name: 'Run workflow', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'artifacts/workflow-editor-browser.png' });
  await manager.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await expect(manager).toHaveCount(0);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.workflow.steps).toEqual([
    { title: 'Research', prompt: 'Read the supplied source' },
    { title: 'Review', prompt: 'Check the preceding result' },
  ]);
  expect(request.agent.provider).toBe('claude');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await page.evaluate(() => {
    (window as any).emitCapability({
      kind: 'workflow',
      workflow: {
        revision: 3,
        name: 'Research and review',
        steps: [
          { title: 'Research', status: 'complete' },
          { title: 'Review', status: 'running' },
        ],
      },
    });
    (window as any).emitCapability({
      kind: 'plan',
      plan: { revision: 2, steps: [{ id: 'a', title: 'Verify sources', status: 'running' }] },
    });
  });
  const panel = page.locator('.composer-area .plan-panel');
  await expect(panel).toContainText('1/2 complete');
  await expect(panel).toContainText('Verify sources');
  await page.screenshot({ path: 'artifacts/workflow-progress-browser.png' });
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('.message .plan-panel').last()).toContainText('1/2 complete');
  await page.locator('.message .plan-panel').last().locator('summary').click();
  await expect(page.locator('.message .plan-panel').last()).toContainText(
    'Stopped. Remaining steps were not run.',
  );
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page
    .getByRole('button', { name: /Research and review/ })
    .first()
    .click();
  await expect(page.locator('.message .plan-panel')).toContainText('1/2 complete');
  await page.getByRole('button', { name: 'Claude workflows', exact: true }).click();
  await manager.getByRole('combobox', { name: 'Saved workflow', exact: true }).click();
  await manager.getByRole('option', { name: 'Research and review', exact: true }).click();
  await expect(manager.getByLabel('Step 2 prompt', { exact: true })).toHaveValue(
    'Check the preceding result',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(manager.getByRole('button', { name: 'Run workflow', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/workflow-editor-mobile.png' });
});

test('plan snapshots reject stale revisions and do not fabricate success when the reply ends', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Plan the task');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.evaluate(() => {
    (window as any).emitCapability({
      kind: 'plan',
      plan: {
        revision: 2,
        explanation: 'Check before changing',
        steps: [
          { id: 'a', title: 'Inspect files', status: 'complete' },
          { id: 'b', title: 'Run checks', status: 'running' },
        ],
      },
    });
    (window as any).emitCapability({ kind: 'plan', plan: { revision: 1, steps: [] } });
  });
  await expect(page.locator('.composer-area .plan-panel')).toContainText('1/2 complete');
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'I could not run the checks.' });
    (window as any).finishCapabilities('complete');
  });
  const panel = page.locator('.message .plan-panel');
  await panel.locator('summary').click();
  await expect(panel).toContainText('Not confirmed complete');
  await expect(panel).toContainText('Run checks');
});
