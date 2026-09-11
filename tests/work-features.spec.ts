import { nativeWorkflowFixture } from './native-workflow-fixture';
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

test('artifacts dock beside chat and switch to a modal without resetting the preview', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Create a panel counter');
  await page.getByRole('button', { name: 'Send message' }).click();
  const source =
    '<!doctype html><title>Panel counter</title><button onclick="this.textContent=Number(this.textContent)+1">0</button>';
  await page.evaluate((source) => {
    (window as any).emitCapability({
      kind: 'text',
      text: '```html Panel counter\n' + source + '\n```',
    });
    (window as any).finishCapabilities('complete');
  }, source);
  const openPanel = page.getByRole('button', {
    name: 'Open Panel counter in side panel',
    exact: true,
  });
  await openPanel.click();
  const viewer = page.getByRole('dialog', { name: 'Panel counter', exact: true });
  const frame = page.frameLocator('iframe[title="Panel counter preview"]');
  await expect(viewer).toHaveClass(/docked/);
  expect(await viewer.evaluate((element) => element.matches(':modal'))).toBe(false);
  const chatBox = (await page.locator('.chat-layout').boundingBox())!;
  const panelBox = (await viewer.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 1);
  await page.getByLabel('Message', { exact: true }).fill('Draft stays usable beside the preview');
  await frame.getByRole('button', { name: '0', exact: true }).click();
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  const resizer = page.getByRole('separator', { name: 'Resize artifact panel', exact: true });
  const initialWidth = Number(await resizer.getAttribute('aria-valuenow'));
  const handle = (await resizer.boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 160);
  await page.mouse.down();
  await page.mouse.move(handle.x - 116, handle.y + 160, { steps: 6 });
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initialWidth + 120));
  await resizer.press('ArrowRight');
  const resizedWidth = initialWidth + 110;
  await expect(resizer).toHaveAttribute('aria-valuenow', String(resizedWidth));
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  const resizedHandle = (await resizer.boundingBox())!;
  await page.mouse.move(resizedHandle.x + 4, resizedHandle.y + 160);
  await page.mouse.down();
  await page.mouse.move(resizedHandle.x + 84, resizedHandle.y + 160, { steps: 6 });
  await expect(resizer).toHaveAttribute('aria-valuenow', String(resizedWidth - 80));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(resizedWidth));
  await expect(viewer).toBeVisible();
  await resizer.press('End');
  expect((await page.locator('.chat-layout').boundingBox())!.width).toBeGreaterThanOrEqual(419);
  await resizer.press('Home');
  await expect(resizer).toHaveAttribute('aria-valuenow', '360');
  await resizer.press('Enter');
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initialWidth));
  await resizer.press('Shift+ArrowLeft');
  const savedWidth = initialWidth + 50;
  await expect(resizer).toHaveAttribute('aria-valuenow', String(savedWidth));
  await viewer.getByRole('button', { name: 'Open in modal', exact: true }).click();
  expect(await viewer.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Open in side panel', exact: true }).click();
  await expect(viewer).toHaveClass(/docked/);
  await expect(resizer).toHaveAttribute('aria-valuenow', String(savedWidth));
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Draft stays usable beside the preview',
  );
  await viewer.getByRole('button', { name: 'Restart preview' }).click();
  await expect(frame.getByRole('button', { name: '0', exact: true })).toBeVisible();
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(viewer.locator('pre')).toHaveText(source);
  await viewer.getByRole('button', { name: 'Download', exact: true }).click();
  expect(await page.evaluate(() => (window as any).savedArtifact)).toEqual({
    source,
    filename: 'Panel counter.html',
    language: 'html',
  });
  await viewer.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(frame.getByRole('button', { name: '0', exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Close artifact' }).click();
  await openPanel.click();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(savedWidth));
  await page.setViewportSize({ width: 1100, height: 900 });
  expect((await page.locator('.chat-layout').boundingBox())!.width).toBeGreaterThanOrEqual(419);
  await page.setViewportSize({ width: 1380, height: 900 });
  await expect(resizer).toHaveAttribute('aria-valuenow', String(savedWidth));
  await page.screenshot({ path: 'artifacts/artifact-side-panel-browser.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer).not.toHaveClass(/docked/);
  expect(await viewer.evaluate((element) => element.matches(':modal'))).toBe(true);
  const narrowBox = (await viewer.boundingBox())!;
  expect(narrowBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: 'artifacts/artifact-side-panel-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(openPanel).toBeFocused();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Draft stays usable beside the preview',
  );
  await page.setViewportSize({ width: 1380, height: 900 });
  await openPanel.click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(viewer).toHaveCount(0);
});

test('native Claude workflows retain drafts, reported phases and agents through stop and history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: /Claude/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Claude workflows', exact: true }).click();
  const launcher = page.getByRole('dialog', { name: 'Claude workflows' });
  await expect(launcher.getByRole('button', { name: 'Add step' })).toHaveCount(0);
  await launcher.getByLabel('Workflow request').fill('/audit-routes src/routes');
  await launcher.getByRole('button', { name: 'Run native workflow' }).click();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.workflow).toBeUndefined();
  expect(request.agent.provider).toBe('claude');
  expect(request.messages.at(-1).text).toContain('/audit-routes src/routes');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await page.evaluate((snapshot) => {
    (window as any).emitCapability({ kind: 'nativeworkflow', nativeWorkflows: snapshot });
    (window as any).emitCapability({
      kind: 'plan',
      plan: { revision: 2, steps: [{ id: 'a', title: 'Verify sources', status: 'running' }] },
    });
  }, nativeWorkflowFixture());
  const panel = page.locator('.composer-area .native-workflow-panel');
  await expect(panel).toContainText('1/2 agents complete');
  await expect(panel).toContainText('Review');
  await panel.locator('.workflow-agent summary').first().click();
  await expect(panel).toContainText('Route verified');
  await expect(page.locator('.composer-area .plan-panel')).toContainText('Verify sources');
  await page.screenshot({ path: 'artifacts/native-workflow-progress-browser.png' });
  await page.getByRole('button', { name: 'Stop response' }).click();
  const saved = page.locator('.message .native-workflow-panel').last();
  await expect(saved).toContainText('Stopped');
  await saved.locator(':scope > summary').click();
  await expect(saved).toContainText('1/2 agents complete');
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.message .native-workflow-panel')).toContainText('audit-routes');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.message .native-workflow-panel > summary').click();
  await page.screenshot({ path: 'artifacts/native-workflow-progress-mobile.png' });
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
