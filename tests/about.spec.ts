import { test, expect, type Locator } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseChangelog } from '../src/lib/changelog';
import { initialWorkspace } from '../src/lib/domain';
import { createRelay } from '../relay/server';
import { mockDesktop } from './desktop-helper';
import { seedAndPairPwa } from './pwa-helper';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));
const [newest] = releases;
// The desktop mock's native version, which differs from the frontend build's.
const nativeVersion = '0.2.0';

function release(about: Locator, value: string) {
  return about.locator('.releases > li > details').filter({
    has: about
      .page()
      .locator('.release-version', { hasText: new RegExp(`^${value.replaceAll('.', '\\.')}$`) }),
  });
}
const plain = (change: string) => change.replaceAll('`', '');

test('desktop Settings shows the native app version and opens its changelog entry', async ({
  page,
}) => {
  expect(nativeVersion).not.toBe(version);
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const about = page.getByRole('region', { name: 'About', exact: true });
  await expect(about.getByText(`Agent Studio ${nativeVersion}`, { exact: true })).toBeVisible();
  await expect(about.getByRole('heading', { name: 'Changelog', exact: true })).toBeVisible();
  await expect(about.locator('.releases > li')).toHaveCount(Math.min(5, releases.length));

  const current = release(about, nativeVersion);
  await expect(current).toHaveAttribute('open', '');
  await expect(current.locator('summary')).toContainText('Current');
  await expect(current.getByText('The first published release.', { exact: false })).toBeVisible();
  await expect(
    current.getByText('Install signed desktop updates from GitHub Releases in the background', {
      exact: true,
    }),
  ).toBeVisible();

  // Newer releases in the bundled changelog start collapsed and open on request.
  const latest = release(about, newest.version);
  await expect(latest).not.toHaveAttribute('open');
  await expect(latest.locator('summary')).not.toContainText('Current');
  await expect(latest.locator('time')).toHaveAttribute('datetime', newest.date);
  const change = latest.getByText(plain(newest.groups[0].items[0]), { exact: true });
  await expect(change).toBeHidden();
  await latest.locator('summary').click();
  await expect(change).toBeVisible();
  await expect(latest.getByRole('heading', { name: newest.groups[0].title })).toBeVisible();
  await about.screenshot({ path: 'artifacts/about/desktop.png' });
});

test('the Viewer shows its build version, marks it current, and fits a phone', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-about-web-'));
  const token = 'synthetic-about-workspace-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await seedAndPairPwa(page, url, token, initialWorkspace());
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const about = page.getByRole('region', { name: 'About', exact: true });
    await expect(about.getByText(`Agent Studio Viewer ${version}`, { exact: true })).toBeVisible();
    const current = release(about, version);
    await expect(current).toHaveAttribute('open', '');
    await expect(current.locator('summary')).toContainText('Current');
    await expect(
      current.getByText(plain(newest.groups[0].items[0]), { exact: true }),
    ).toBeVisible();
    await expect(about.getByText('Current', { exact: true })).toHaveCount(1);
    await about.screenshot({ path: 'artifacts/about/viewer.png' });

    await page.setViewportSize({ width: 390, height: 844 });
    const box = await about.locator('.releases').boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await about.screenshot({ path: 'artifacts/about/viewer-phone.png' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
