import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

/** A 1×1 PNG: the mock host returns it for the call that kept the reply's files. */
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a reply shows the files it sent where its marker stands, reading them from its computer', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  // The images stay on the mock host, so a reloaded window can ask for them again.
  await page.addInitScript((data) => {
    (window as any).toolOutputs = {
      toolu_01: { images: [{ mediaType: 'image/png', data, bytes: 68, width: 1, height: 1 }] },
    };
  }, png);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Render the chart');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    const runId = Object.keys(w.capabilityRuns)[0];
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'chart',
        revision: 1,
        runId,
        toolId: 'toolu_01',
        caption: 'Requests per second',
        files: [
          { index: 0, name: 'chart.png', mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
        ],
      },
    });
    // A group whose run is not this reply's is never shown.
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'foreign',
        revision: 1,
        runId: crypto.randomUUID(),
        toolId: 'toolu_02',
        files: [{ index: 0, name: 'other.png', mediaType: 'image/png', bytes: 68 }],
      },
    });
    w.emitCapability({
      kind: 'text',
      text: 'Here is the chart.\n\n<!-- files:chart -->\n\nIt levels off after ten workers.',
    });
    w.finishCapabilities('complete');
  });

  const reply = page.locator('.message:not(.user)');
  const image = reply.getByAltText('Image 1 returned by chart.png');
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${png}`);
  await expect(reply.getByText('Requests per second')).toBeVisible();
  await expect(reply.getByAltText('Image 1 returned by other.png')).toHaveCount(0);

  // The files stand between the paragraphs their marker separates.
  const before = reply.locator('.prose').filter({ hasText: 'Here is the chart' });
  const after = reply.locator('.prose').filter({ hasText: 'levels off' });
  const box = (await image.boundingBox())!;
  expect((await before.boundingBox())!.y).toBeLessThan(box.y);
  expect((await after.boundingBox())!.y).toBeGreaterThan(box.y);

  await image.click();
  await expect(page.getByLabel('Image preview').getByText('chart.png')).toBeVisible();
  await page.getByRole('button', { name: 'Close image preview' }).click();

  // The saved reply keeps the reference and never the image bytes.
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace') ?? '');
  expect(saved).toContain('toolu_01');
  expect(saved).not.toContain(png.slice(0, 40));

  // A reloaded window reads the image from the computer that ran the reply again.
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(
    page.locator('.message:not(.user)').getByAltText('Image 1 returned by chart.png'),
  ).toHaveAttribute('src', `data:image/png;base64,${png}`);
});
