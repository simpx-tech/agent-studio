import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { triangleGlbBase64 } from './model-fixture';

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

test('a sent 3D model opens in a viewer with its animation, and expands to full size', async ({
  page,
}) => {
  const glb = triangleGlbBase64();
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = {
      toolu_03: { models: [{ format: 'glb', data, bytes: 220 }] },
    };
  }, glb);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Show me the character');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    const runId = Object.keys(w.capabilityRuns)[0];
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'character',
        revision: 1,
        runId,
        toolId: 'toolu_03',
        caption: 'Base mesh, spinning',
        files: [{ index: 0, name: 'figure.glb', mediaType: 'model/gltf-binary', bytes: 220 }],
      },
    });
    w.emitCapability({
      kind: 'text',
      text: 'Here is the model.\n\n<!-- files:character -->\n\nThe silhouette reads well.',
    });
    w.finishCapabilities('complete');
  });

  const reply = page.locator('.message:not(.user)');
  const canvas = reply.getByLabel('3D model figure.glb');
  await expect(canvas).toBeVisible();
  await expect(reply.getByText('Base mesh, spinning')).toBeVisible();
  // The clip comes from the parsed file, so the viewer really read this GLB.
  await expect(reply.getByRole('button', { name: 'Pause animation' })).toBeVisible();
  await expect(reply.getByText('GLB · ')).toBeVisible();
  await expect(reply.locator('.model-note.failed')).toHaveCount(0);
  // Drawing starts only once the canvas has a size on screen.
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(100);

  const before = reply.locator('.prose').filter({ hasText: 'Here is the model' });
  const after = reply.locator('.prose').filter({ hasText: 'silhouette' });
  expect((await before.boundingBox())!.y).toBeLessThan((await canvas.boundingBox())!.y);
  expect((await after.boundingBox())!.y).toBeGreaterThan((await canvas.boundingBox())!.y);

  const inline = (await canvas.boundingBox())!.width;
  await reply.getByRole('button', { name: 'Expand figure.glb' }).click();
  const preview = page.getByLabel('Model preview');
  await expect(preview.getByLabel('3D model figure.glb')).toBeVisible();
  expect((await preview.getByLabel('3D model figure.glb').boundingBox())!.width).toBeGreaterThan(
    inline,
  );
  await page.getByRole('button', { name: 'Close model preview' }).click();
  await expect(page.getByLabel('Model preview')).toBeHidden();
  await expect(reply.getByLabel('3D model figure.glb')).toBeVisible();

  // The model's bytes stay on the computer that ran the reply.
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace') ?? '');
  expect(saved).toContain('model/gltf-binary');
  expect(saved).not.toContain(glb.slice(0, 40));
});
