import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { initialWorkspace } from '../src/lib/domain';
import { createRelay } from '../relay/server';
import { createWorkspace } from '../relay/workspaces';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedAndPairPwa, signInPwa } from './pwa-helper';

async function createTemplate(
  page: Page,
  name = 'Review a change',
  body = 'Review {{change}}.\nFocus on {{areas to check}}.\nChange: {{ change }}',
) {
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  await page.getByLabel('Template name', { exact: true }).fill(name);
  await page.getByLabel('Template text', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Input templates', exact: true })).toBeVisible();
}
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace') ?? '{}'));

test('templates remain unavailable until the saved workspace has loaded', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: unknown) => {
      if (command === 'load_workspace')
        await new Promise<void>((resolve) => {
          (window as any).releaseTemplateLoad = resolve;
        });
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Templates', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).releaseTemplateLoad());
  await expect(page.getByRole('button', { name: 'Templates', exact: true })).toBeEnabled();
  await createTemplate(page, 'After load', 'Reusable text');
  expect((await saved(page)).inputTemplates[0].body).toBe('Reusable text');
});

test('create, fill, preview and insert preserve the draft and attachments without sending; templates survive reload and support edit/delete', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Existing draft  ');
  await page.getByLabel('Image files').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await createTemplate(page);
  await page.getByRole('button', { name: 'Use Review a change' }).click();
  await expect(page.getByRole('button', { name: 'Insert into message' })).toBeDisabled();
  await page.getByLabel('change', { exact: true }).fill('Login flow\nwith mobile support');
  await page
    .getByLabel('areas to check', { exact: true })
    .fill('{{change}} $& <script>window.templateExecuted=true</script>');
  const result =
    'Existing draft  \n\nReview Login flow\nwith mobile support.\nFocus on {{change}} $& <script>window.templateExecuted=true</script>.\nChange: Login flow\nwith mobile support';
  await expect(page.locator('.template-preview pre')).toHaveText(result);
  await page.screenshot({ path: 'artifacts/input-templates-preview-desktop.png' });
  expect((await saved(page)).inputTemplates[0].body).toContain('{{change}}');
  expect(JSON.stringify(await saved(page))).not.toContain('with mobile support');
  await page.getByRole('button', { name: 'Insert into message' }).click();
  await expect(input).toHaveValue(result);
  await expect(input).toBeFocused();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Remove pixel.png/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBeNull();
  expect(await page.evaluate(() => (window as any).templateExecuted)).toBeUndefined();
  await page.screenshot({ path: 'artifacts/input-templates-inserted-desktop.png' });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('test-drafts')))
    .toContain('Review Login flow');
  await page.reload();
  // The unsent text returns after a restart; attached images stay only while the app is open.
  await expect(input).toHaveValue(result);
  await expect(page.getByRole('button', { name: /Remove pixel.png/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Review a change' }).click();
  await page.getByLabel('Template name').fill('Explain a topic');
  await page.getByLabel('Template text').fill('Explain {{topic}}.');
  await page.getByRole('button', { name: 'Save template' }).click();
  await page.getByRole('button', { name: 'Use Explain a topic' }).click();
  await expect(page.getByLabel('topic', { exact: true })).toHaveValue('');
  await page.getByLabel('topic', { exact: true }).fill('Temporary value');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue(result);
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Explain a topic' }).click();
  await page.getByRole('button', { name: 'Cancel deletion' }).click();
  await expect(page.getByRole('button', { name: 'Use Explain a topic' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Explain a topic' }).click();
  await page.getByRole('button', { name: 'Delete template', exact: true }).click();
  await expect(page.getByText('No templates yet')).toBeVisible();
  await expect.poll(async () => (await saved(page)).inputTemplates).toEqual([]);
  expect(errors).toEqual([]);
});

test('input insertion keeps a History chat archived until the user explicitly sends', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial message');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message:not(.user)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  const original = (await saved(page)).conversations[0];
  await createTemplate(page, 'Follow up', 'Explain {{topic}}');
  await page.getByRole('button', { name: 'Use Follow up' }).click();
  await page.getByLabel('topic', { exact: true }).fill('the next step');
  await page.getByRole('button', { name: 'Insert into message' }).click();
  await expect(input).toHaveValue('Explain the next step');
  expect((await saved(page)).conversations[0]).toEqual(original);
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  expect((await saved(page)).conversations[0].archived).toBe(false);
  await expect(page.locator('.message.user').last()).toContainText('Explain the next step');
});

test('validation, save failure recovery and combined length limits keep user input intact', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await createTemplate(page, 'Small prompt', 'Use {{constructor}}');
  await page.getByRole('button', { name: 'Use Small prompt' }).click();
  await expect(page.getByLabel('constructor', { exact: true })).toHaveValue('');
  await page.getByLabel('constructor', { exact: true }).fill('x'.repeat(30000));
  await expect(page.getByRole('alert')).toContainText('30,000');
  await expect(page.getByRole('button', { name: 'Insert into message' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Small prompt' }).click();
  await page.getByLabel('Template text').fill('Broken {{field');
  await expect(page.getByRole('alert')).toContainText('Close each field');
  await expect(page.getByRole('button', { name: 'Save template' })).toBeDisabled();
  await page.getByLabel('Template text').fill('Explain ');
  await page.getByLabel('Template text').press('End');
  await page.getByRole('button', { name: 'Add input field' }).click();
  await expect(page.getByLabel('Template text')).toHaveValue('Explain {{input 1}}');
  await page.getByLabel('Template text').pressSequentially('topic');
  await expect(page.getByLabel('Template text')).toHaveValue('Explain {{topic}}');
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = (command: string, args: unknown) => {
      if (command === 'save_workspace' && (window as any).failTemplateSave)
        return Promise.reject('Synthetic disk failure');
      return invoke(command, args);
    };
    (window as any).failTemplateSave = true;
  });
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('Template text')).toHaveValue('Explain {{topic}}');
  expect((await saved(page)).inputTemplates[0].body).toBe('Use {{constructor}}');
  await page.evaluate(() => {
    (window as any).failTemplateSave = false;
  });
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('heading', { name: 'Input templates', exact: true })).toBeVisible();
  expect((await saved(page)).inputTemplates[0].body).toBe('Explain {{topic}}');
});

test('mobile templates scroll internally with fixed controls and remain usable by keyboard', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await createTemplate(
    page,
    'Project brief',
    Array.from({ length: 12 }, (_, i) => `{{detail ${i + 1}}}`).join('\n'),
  );
  await page.getByRole('button', { name: 'Use Project brief' }).click();
  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 460 },
  ]) {
    await page.setViewportSize(size);
    const dialog = page.getByRole('dialog');
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    expect(await dialog.evaluate((el) => el.scrollHeight === el.clientHeight)).toBe(true);
    expect(
      await page.locator('.template-body').evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await expect(page.getByRole('button', { name: 'Insert into message' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Close input templates' })).toBeInViewport();
    await page.screenshot({ path: `artifacts/input-templates-mobile-${size.width}.png` });
  }
  await page.getByLabel('detail 12', { exact: true }).fill('Keyboard check');
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => document.querySelector('dialog')?.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
});

test('production relay sync shares templates across devices, rejects stale edits and isolates workspace sign-in', async ({
  page,
  browser,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-template-web-'));
  const token = 'synthetic-template-workspace-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const member = createWorkspace({ directory, name: 'Separate workspace' });
  const other = await browser.newContext();
  const second = await other.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await seedAndPairPwa(page, url, token, initialWorkspace());
    await createTemplate(page, 'Shared brief', 'Write about {{topic}}');
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${url}/v1/state`, {
            headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
          });
          expect(response.status()).toBe(200);
          return (await response.json()).workspace?.inputTemplates?.length;
        },
        { timeout: 15000 },
      )
      .toBe(1);
    await second.goto(url);
    await signInPwa(second, token);
    await second.getByRole('button', { name: 'Templates', exact: true }).click();
    await second.getByRole('button', { name: 'Edit Shared brief' }).click();
    await page.getByRole('button', { name: 'Edit Shared brief' }).click();
    await page.getByLabel('Template text').fill('New version {{topic}}');
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect
      .poll(
        async () =>
          second.evaluate(() => {
            const key = Object.keys(localStorage).find(
              (key) =>
                key.startsWith('agent-studio.private-workspace.v1:') &&
                !key.endsWith(':sync') &&
                !key.endsWith(':backup'),
            );
            return key ? JSON.parse(localStorage.getItem(key)!).inputTemplates?.[0]?.body : '';
          }),
        { timeout: 15000 },
      )
      .toBe('New version {{topic}}');
    await second.getByLabel('Template text').fill('Stale edit {{topic}}');
    await second.getByRole('button', { name: 'Save template' }).click();
    await expect(second.getByRole('dialog').getByRole('alert')).toContainText(
      'changed on another device',
    );
    await page.getByRole('button', { name: 'Close input templates' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByText('Sync settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await signInPwa(page, member.token);
    // A workspace replacement retains the Connections view; return through the logo.
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await expect(page.getByText('No templates yet')).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain('Shared brief');
    expect(errors).toEqual([]);
  } finally {
    await other.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
