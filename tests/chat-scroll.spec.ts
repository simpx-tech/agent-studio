import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

for (const mobile of [false, true])
  test(`long running chat stays scrollable ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await chooseTestFolder(page);
    await page.getByLabel('Message', { exact: true }).fill('First message in the conversation');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    await page.evaluate(() => {
      const w = window as any;
      for (let i = 0; i < 30; i++)
        w.emitCapability({
          kind: 'tool',
          tool: {
            id: `scroll-tool-${i}`,
            revision: 1,
            category: 'tool',
            name: 'Run command',
            status: 'complete',
            detail: `Read project context ${i}`,
            sources: [],
            agents: [],
          },
        });
    });
    await page.locator('.activity-group > summary').click();
    for (const summary of await page.locator('.tool-card > summary').all()) await summary.click();
    const scroll = page.locator('.chat-scroll');
    const position = () =>
      scroll.evaluate((el) => ({
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        height: el.clientHeight,
      }));
    await expect.poll(async () => (await position()).max).toBeGreaterThan(2000);
    await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
    await expect
      .poll(async () => {
        const p = await position();
        return p.max - p.top;
      })
      .toBeLessThan(2);
    await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
    await scroll.hover();
    await page.mouse.wheel(0, -60);
    await expect
      .poll(async () => {
        const p = await position();
        return p.max - p.top;
      })
      .toBeGreaterThan(40);
    const reading = (await position()).top;
    await page.evaluate(() =>
      (window as any).emitCapability({ kind: 'activity', text: 'Checking one more file' }),
    );
    // Let an attempted smooth automatic scroll finish, so a transient position cannot pass.
    await page.waitForTimeout(700);
    await scroll.screenshot({ path: `artifacts/chat-scroll-${mobile ? 'mobile' : 'desktop'}.png` });
    expect((await position()).top).toBeLessThanOrEqual(reading + 2);
    await page.mouse.wheel(0, -50000);
    await expect.poll(async () => (await position()).top).toBeLessThan(2);
    await expect(
      scroll.getByText('First message in the conversation', { exact: true }),
    ).toBeInViewport();
    await page.mouse.wheel(0, 50000);
    await expect
      .poll(async () => {
        const p = await position();
        return p.max - p.top;
      })
      .toBeLessThan(2);
    await page.evaluate(() =>
      (window as any).emitCapability({
        kind: 'text',
        text: 'Final answer at the end of the chat.\n\n'.repeat(80),
      }),
    );
    await expect(scroll.locator('.prose p')).toHaveCount(80);
    await expect
      .poll(async () => {
        const p = await position();
        return p.max - p.top;
      })
      .toBeLessThan(2);
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await page.getByLabel('Work history', { exact: true }).click();
    await page.locator('.activity-group > summary').click();
    await scroll.hover();
    await page.mouse.wheel(0, 50000);
    await expect
      .poll(async () => {
        const p = await position();
        return p.max - p.top;
      })
      .toBeLessThan(2);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
    await expect(page.getByRole('form', { name: 'Message composer' })).toBeInViewport();
  });
