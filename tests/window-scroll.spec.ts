import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// A window shorter than the shell used to scroll the whole document, carrying the
// title bar and sidebar off screen. The shell fills the viewport; regions scroll.
test('a short window never scrolls the whole app', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.locator('.app-shell').waitFor();
  for (const height of [900, 600, 560, 460, 360]) {
    await page.setViewportSize({ width: 1380, height });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.scrollingElement as HTMLElement;
          return root.scrollHeight - root.clientHeight;
        }),
      )
      .toBe(0);
    await page.mouse.move(700, Math.round(height / 2));
    await page.mouse.wheel(0, 400);
    expect(
      await page.evaluate(() => ({
        scrollTop: (document.scrollingElement as HTMLElement).scrollTop,
        topbar: document.querySelector('.topbar')!.getBoundingClientRect().top,
      })),
    ).toEqual({ scrollTop: 0, topbar: 0 });
    // The composer stays reachable instead of being clipped by the shell.
    const send = await page
      .getByRole('button', { name: 'Send message', exact: true })
      .evaluate((el) => el.getBoundingClientRect());
    expect(send.bottom).toBeLessThanOrEqual(height);
    expect(send.top).toBeGreaterThan(0);
  }
});
