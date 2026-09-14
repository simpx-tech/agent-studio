import { test as base, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

// Layout coverage exercises the authenticated PWA, including real browser
// transport and session restoration, rather than relying on a signed-out shell.
const test = base.extend<{ openPwa: () => Promise<void> }>({
  openPwa: async ({ page }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-mobile-layout-'));
    const token = 'synthetic-mobile-layout-workspace-key';
    const server = createRelay({ token, directory, webDirectory: resolve('build') });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const workspace = initialWorkspace();
    const computerId = crypto.randomUUID(),
      environmentId = crypto.randomUUID(),
      accountId = crypto.randomUUID();
    workspace.fleet.computers.push({ id: computerId, name: 'Layout computer' });
    workspace.fleet.environments.push({
      id: environmentId,
      computerId,
      name: 'Windows',
      platform: 'windows',
    });
    workspace.fleet.accounts.push({
      id: accountId,
      name: 'Layout account',
      provider: 'codex',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId,
      accountId,
      profile: 'existing',
    });
    try {
      await use(() => seedAndPairPwa(page, url, token, workspace));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function visualViewport(page: Page, height: number, offsetTop = 0, event = 'resize') {
  await page.evaluate(
    ({ height, offsetTop, event }) => {
      Object.assign(window.visualViewport!, { height, offsetTop });
      window.visualViewport!.dispatchEvent(new Event(event));
    },
    { height, offsetTop, event },
  );
}

test('composer follows keyboard resize and pan, then fills the standalone screen again', async ({
  page,
  openPwa,
}, testInfo) => {
  // Desktop browser viewport resizing cannot reproduce iOS keyboard panning.
  // Supply the separate visual viewport signals while keeping the layout 844px high.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await openPwa();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const composer = page.locator('.composer-area');
  await expect(input).toBeVisible();
  const bottom = async () => {
    const box = await composer.boundingBox();
    return Math.round(box!.y + box!.height);
  };
  await expect.poll(bottom).toBe(844);
  await input.focus();
  await visualViewport(page, 460, 150);
  await expect.poll(bottom).toBe(610);
  await input.pressSequentially('Typing with the keyboard open');
  await expect.poll(bottom).toBe(610);
  const inputBox = await input.boundingBox();
  expect(inputBox!.y).toBeGreaterThan(150);
  expect(inputBox!.y + inputBox!.height).toBeLessThan(610);
  await page.screenshot({ path: testInfo.outputPath('keyboard-resize-and-pan.png') });

  // Safari can pan without a resize, and dismissal can leave a small stale inset.
  await visualViewport(page, 460, 80, 'scroll');
  await expect.poll(bottom).toBe(540);
  await input.blur();
  await visualViewport(page, 800, 44);
  await expect.poll(bottom).toBe(844);
  await expect(input).toHaveValue('Typing with the keyboard open');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('keyboard-dismissed.png') });

  // Repeat focus/dismissal and handle a delayed geometry update without another resize event.
  await input.focus();
  await visualViewport(page, 460);
  await expect.poll(bottom).toBe(460);
  await input.blur();
  await page.evaluate(() => Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 }));
  await expect.poll(bottom).toBe(844);
  await page.setViewportSize({ width: 390, height: 740 });
  await visualViewport(page, 740);
  await expect.poll(bottom).toBe(740);
});

test('mobile dropdowns stay beside their trigger and remain usable in a scrolled toolbar', async ({
  page,
  openPwa,
}, testInfo) => {
  await openPwa();
  const computer = page.getByRole('combobox', { name: 'Computer', exact: true });
  await expect(computer).toBeEnabled();
  await computer.click();
  const panel = page.locator('.picker-popover:popover-open');
  await expect(panel).toBeVisible();
  let anchor = (await computer.boundingBox())!;
  let box = (await panel.boundingBox())!;
  expect(Math.abs(box.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.scrollIntoViewIfNeeded();
  await model.click();
  await expect(panel).toBeVisible();
  anchor = (await model.boundingBox())!;
  box = (await panel.boundingBox())!;
  expect(Math.abs(box.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  const toolbarScroll = await page
    .locator('.chat-configuration')
    .evaluate((node) => node.scrollLeft);
  await page.keyboard.press('End');
  expect(await page.locator('.chat-configuration').evaluate((node) => node.scrollLeft)).toBe(
    toolbarScroll,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('anchored-mobile-picker.png') });
  await page.getByRole('option').last().click();
  await expect(panel).toHaveCount(0);
  await expect(model).toBeFocused();
});

test('installed app keeps full usage tracks inside the page when fullscreen metrics exceed its visible height', async ({
  page,
  openPwa,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      writable: true,
      value: true,
    });
    // iOS 26 can report a fullscreen size larger than its drawable web view.
    // Keep the real test viewport at 844px; this metric must not enlarge it.
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => window.visualViewport!.height + 62,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        width: 390,
        height: 844,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
      }),
    });
  });
  await openPwa();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(input).toBeVisible();
  // Check the tracks themselves, including hit testing at both vertical edges.
  // The browser provides the safe rectangle; the app must not pad it again.
  const bottom = (selector: string) =>
    page.locator(selector).evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
  await expect.poll(() => bottom('.app-shell')).toBe(844);
  await expect.poll(() => bottom('html')).toBe(844);
  await expect.poll(() => bottom('body')).toBe(844);
  await expect.poll(() => bottom('.composer-area')).toBe(844);
  const tracks = page.locator('.usage-meter.compact-meter');
  const assertTracks = async (visibleBottom: number, bottomInset: number) => {
    expect(await tracks.count()).toBeGreaterThan(0);
    for (const track of await tracks.all()) {
      const box = (await track.boundingBox())!;
      expect(box.height).toBe(6);
      expect(box.y + box.height).toBeLessThanOrEqual(visibleBottom - bottomInset);
      expect(
        await track.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return [rect.top + 0.5, rect.bottom - 0.5].every((y) => {
            const hit = document.elementFromPoint(rect.x + rect.width / 2, y);
            return hit !== null && (node.contains(hit) || hit.contains(node));
          });
        }),
      ).toBe(true);
    }
    // Credits can add a second row. Every track must remain fully painted;
    // measure the bottom inset from the strip, not from its first row.
    const strip = (await page.locator('.usage-strip').boundingBox())!;
    expect(visibleBottom - bottomInset - strip.y - strip.height).toBeLessThanOrEqual(15);
  };
  await assertTracks(844, 0);
  await page.screenshot({ path: testInfo.outputPath('standalone-safe-area-tracks.png') });
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect.poll(() => bottom('.sidebar')).toBe(844);
  await expect.poll(() => bottom('.sidebar-backdrop')).toBe(844);
  await expect.poll(() => bottom('.sidebar-tools')).toBe(844);
  await page.screenshot({ path: testInfo.outputPath('standalone-safe-area-drawer.png') });
  await page.keyboard.press('Escape');
  await input.focus();
  await visualViewport(page, 460, 80);
  await expect.poll(() => bottom('.app-shell')).toBe(540);
  await expect.poll(() => bottom('.composer-area')).toBe(540);
  await expect.poll(() => bottom('.sidebar')).toBe(540);
  await assertTracks(540, 0);
  await input.blur();
  await visualViewport(page, 844);
  await expect.poll(() => bottom('.app-shell')).toBe(844);
  await expect.poll(() => bottom('.sidebar')).toBe(844);
  await assertTracks(844, 0);

  // A changed window must replace, not retain, the previous full-screen size.
  await page.setViewportSize({ width: 390, height: 740 });
  await visualViewport(page, 740);
  await expect.poll(() => bottom('.composer-area')).toBe(740);
  await expect.poll(() => bottom('.sidebar')).toBe(740);
  await assertTracks(740, 0);

  // A normal browser tab still reserves space for its real browser controls.
  await page.evaluate(() => {
    Object.assign(navigator, { standalone: false });
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect.poll(() => bottom('.app-shell')).toBe(740);
  await expect.poll(() => bottom('.sidebar')).toBe(740);
  await assertTracks(740, 0);
});

test('the phone reserves its safe area once, without adding a second navigation inset', async ({
  page,
  openPwa,
  browserName,
}, testInfo) => {
  await page.setViewportSize({ width: 430, height: 932 });
  // Exercise actual env() values in Chromium, rather than substituting a
  // stylesheet variable. Other engines still verify the fitted-page layout.
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 59, bottom: 93, left: 0, right: 0 },
    });
  }
  await openPwa();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const bottomGap = async () =>
    page
      .locator('.usage-strip')
      .evaluate(
        (node) =>
          document.documentElement.getBoundingClientRect().bottom -
          node.getBoundingClientRect().bottom,
      );
  await page.screenshot({ path: testInfo.outputPath('automatic-safe-area-chat.png') });
  await expect.poll(bottomGap).toBe(10);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /viewport-fit=auto/,
  );
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect(page.locator('.sidebar-tools')).toBeVisible();
  expect(
    await page
      .locator('.sidebar-tools')
      .evaluate(
        (node) =>
          document.documentElement.getBoundingClientRect().bottom -
          node.getBoundingClientRect().bottom,
      ),
  ).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('automatic-safe-area-drawer.png') });
  await page.keyboard.press('Escape');

  // The browser owns the excluded screen area. Resize to a smaller usable
  // rectangle, as when browser controls change, without changing it back
  // to a physical fullscreen height or adding the device insets a second time.
  await page.setViewportSize({ width: 390, height: 751 });
  await expect.poll(bottomGap).toBe(10);
});
