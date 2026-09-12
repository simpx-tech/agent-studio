import { test, expect, devices } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { windowsInstallerName } from '../src/lib/installation';
import { signInPwa } from './pwa-helper';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-install-browser-'));
  const downloadsDirectory = join(directory, 'packages');
  mkdirSync(downloadsDirectory);
  const bytes = Buffer.from('MZ synthetic download fixture');
  writeFileSync(join(downloadsDirectory, windowsInstallerName), bytes);
  const token = 'synthetic-install-browser-workspace-key';
  const server = createRelay({
    token,
    directory,
    downloadsDirectory,
    webDirectory: resolve('build'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    server,
    url,
    token,
    bytes,
    downloadsDirectory,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('desktop offers Viewer installation and a real download before and after workspace login', async ({
  page,
}, testInfo) => {
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(f.url);
    await expect(page.locator('.login-brand .viewer-label')).toHaveText('Viewer');
    await expect(page).toHaveTitle('Agent Studio Viewer');
    await page.getByRole('button', { name: 'Install app', exact: true }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Install Agent Studio', exact: true });
    await expect(dialog.getByRole('heading', { name: 'Viewer PWA' })).toBeVisible();
    const link = dialog.getByRole('link', { name: 'Download for Windows' });
    await expect(link).toBeVisible();
    const downloadEvent = page.waitForEvent('download');
    await link.click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(windowsInstallerName);
    expect(readFileSync((await download.path())!)).toEqual(f.bytes);
    await expect(page.locator('.workspace-login')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('desktop-install-options.png') });
    await dialog.getByRole('button', { name: 'Install Viewer', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('browser’s install option');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Install app', exact: true })).toBeFocused();
    await signInPwa(page, f.token);
    await expect(page.locator('.brand .viewer-label')).toHaveText('Viewer');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my draft');
    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    await expect(link).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Keep my draft',
    );
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys())
        for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
      return urls;
    });
    expect(cached.some((url) => url.includes('/downloads/'))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('phones offer only Viewer with installation help and retain modal controls at narrow sizes', async ({
  browser,
}, testInfo) => {
  const f = await fixture();
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  try {
    await page.goto(f.url);
    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Agent Studio', exact: true });
    await expect(dialog.getByRole('heading', { name: 'Desktop app', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Install Viewer', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Add to Home Screen');
    await page.setViewportSize({ width: 320, height: 480 });
    await expect(
      dialog.getByRole('button', { name: 'Close install agent studio' }),
    ).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('phone-install-options.png') });
    await page.getByRole('button', { name: 'Close install agent studio' }).click();
    await expect(dialog).toHaveCount(0);
    await signInPwa(page, f.token);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Keep this mobile draft');
    await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    const install = page
      .locator('.sidebar-tools')
      .getByRole('button', { name: 'Install app', exact: true });
    await expect(install).toBeInViewport();
    await expect(page.locator('.main-area .install-button')).toHaveCount(0);
    await install.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.sidebar')).toHaveClass(/mobile-open/);
    await expect(install).toBeFocused();
    await page.getByRole('button', { name: 'Close conversations', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Keep this mobile draft',
    );
  } finally {
    await context.close();
    await f.close();
  }
});

test('desktop download failures can be retried and missing packages never get a download link', async ({
  page,
}) => {
  const f = await fixture();
  let unavailable = true;
  const handle = f.server.listeners('request')[0];
  f.server.removeAllListeners('request');
  f.server.on('request', (req, res) => {
    if (unavailable && req.url === '/downloads/manifest.json') res.writeHead(503).end();
    else handle.call(f.server, req, res);
  });
  try {
    await page.goto(f.url);
    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Agent Studio' });
    await expect(dialog.getByRole('alert')).toHaveText('Could not check desktop downloads.');
    unavailable = false;
    rmSync(join(f.downloadsDirectory, windowsInstallerName));
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('not available on this server');
    await expect(dialog.getByRole('link', { name: 'Download for Windows' })).toHaveCount(0);
  } finally {
    await f.close();
  }
});
