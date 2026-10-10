import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { triangleGlb, triangleGlbBase64 } from './model-fixture';

/**
 * The shown-model viewer keeps a bounded number of WebGL scenes, builds each once its stage is
 * on screen, reads a model only when it comes near, and rebuilds what the browser or the reader
 * takes away. Each of these used to fail in its own way: models went blank past the browser's
 * context limit, a replaced group kept its old model, a pause snapped to the rest pose, and
 * Retry after a drawing failure left an empty stage.
 */
const animated = triangleGlbBase64();
const still = triangleGlbBase64({ animated: false });
const bytes = triangleGlb().byteLength;
type Group = { id: string; toolId: string; count: number };

/** Sends a message and answers it with `text`, showing each group of models. */
async function reply(page: Page, groups: Group[], text: string) {
  await page.getByLabel('Message', { exact: true }).fill('Show me the models');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(
    ({ groups, text, bytes }) => {
      const w = window as any;
      const runId = Object.keys(w.capabilityRuns)[0];
      // The prose first, so each group appears where its marker already stands.
      w.emitCapability({ kind: 'text', text });
      for (const group of groups)
        w.emitCapability({
          kind: 'sentfiles',
          sentFiles: {
            id: group.id,
            revision: 1,
            runId,
            toolId: group.toolId,
            files: Array.from({ length: group.count }, (_, index) => ({
              index,
              name: `${group.id}-${index}.glb`,
              mediaType: 'model/gltf-binary',
              bytes,
            })),
          },
        });
      w.finishCapabilities('complete');
    },
    { groups, text, bytes },
  );
}
const modelReads = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).toolOutputCalls ?? []).filter(
        (call: { command: string }) => call.command === 'read_tool_output_model_file',
      ).length,
  );

test('a model far above the end is read only when the reader scrolls to it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = { toolu_far: { models: [{ format: 'glb', data, bytes: 1 }] } };
  }, animated);
  await page.goto('/');
  await chooseTestFolder(page);
  const paragraphs = Array.from(
    { length: 90 },
    (_, i) => `Paragraph ${i + 1} explains one more detail of the model and its materials.`,
  ).join('\n\n');
  await reply(
    page,
    [{ id: 'far', toolId: 'toolu_far', count: 1 }],
    `<!-- files:far -->\n\n${paragraphs}`,
  );
  const reply_ = page.locator('.message:not(.user)');
  await expect(reply_.getByText('Paragraph 90 explains')).toBeVisible();
  await page.waitForTimeout(600);
  expect(await modelReads(page)).toBe(0);
  await reply_.locator('.model-stage').scrollIntoViewIfNeeded();
  await expect(reply_.getByLabel('3D model far-0.glb')).toBeVisible();
  expect(await modelReads(page)).toBe(1);
});

test('a window keeps at most eight scenes and rebuilds one scrolled back to', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    const model = { format: 'glb', data, bytes: 1 };
    (window as any).toolOutputs = {
      toolu_many: { models: Array(8).fill(model) },
      toolu_more: { models: Array(4).fill(model) },
    };
  }, animated);
  await page.goto('/');
  await chooseTestFolder(page);
  await reply(
    page,
    [
      { id: 'many', toolId: 'toolu_many', count: 8 },
      { id: 'more', toolId: 'toolu_more', count: 4 },
    ],
    'The first set.\n\n<!-- files:many -->\n\nThe second set.\n\n<!-- files:more -->\n\nThat is all.',
  );
  const answer = page.locator('.message:not(.user)');
  const stages = answer.locator('.model-stage');
  await expect(stages).toHaveCount(12);
  const live = () => page.locator('.model-canvas').count();
  for (let index = 0; index < 12; index++) {
    await stages.nth(index).scrollIntoViewIfNeeded();
    await expect(
      answer.getByLabel(`3D model ${index < 8 ? 'many' : 'more'}-${index % 8}.glb`),
    ).toBeVisible();
    expect(await live()).toBeLessThanOrEqual(8);
  }
  // The first stage gave its scene to a later one, and builds a new one when it returns.
  await stages.first().scrollIntoViewIfNeeded();
  await expect(answer.getByLabel('3D model many-0.glb')).toBeVisible();
  expect(await live()).toBeLessThanOrEqual(8);
  await expect(answer.locator('.model-note.failed')).toHaveCount(0);
});

test('a group sent again under its id shows the model it now names', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    ({ animated, still }) => {
      (window as any).toolOutputs = {
        toolu_first: { models: [{ format: 'glb', data: animated, bytes: 1 }] },
        toolu_second: { models: [{ format: 'glb', data: still, bytes: 1 }] },
      };
    },
    { animated, still },
  );
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Make the figure');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const send = (toolId: string, revision: number) =>
    page.evaluate(
      ({ toolId, revision, bytes }) => {
        const w = window as any;
        w.emitCapability({
          kind: 'sentfiles',
          sentFiles: {
            id: 'figure',
            revision,
            runId: Object.keys(w.capabilityRuns)[0],
            toolId,
            files: [{ index: 0, name: 'figure.glb', mediaType: 'model/gltf-binary', bytes }],
          },
        });
      },
      { toolId, revision, bytes },
    );
  await send('toolu_first', 1);
  const answer = page.locator('.message:not(.user)');
  await expect(answer.getByRole('button', { name: 'Pause animation' })).toBeVisible();
  // The corrected model carries no animation, so its controls lose the pause button.
  await send('toolu_second', 2);
  await expect(answer.getByRole('button', { name: 'Pause animation' })).toHaveCount(0);
  await expect(answer.getByLabel('3D model figure.glb')).toBeVisible();
  await expect(answer.locator('.model-note.failed')).toHaveCount(0);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
});

test('a model that cannot be drawn names why, and Retry draws it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = { toolu_gl: { models: [{ format: 'glb', data, bytes: 1 }] } };
    // WebGL refused, as on a device or remote session without it, until the test allows it.
    (window as any).denyWebGL = true;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      if ((window as any).denyWebGL && String(args[0]).startsWith('webgl')) return null;
      return (getContext as any).apply(this, args);
    } as typeof getContext;
  }, animated);
  await page.goto('/');
  await chooseTestFolder(page);
  await reply(page, [{ id: 'gl', toolId: 'toolu_gl', count: 1 }], 'Here.\n\n<!-- files:gl -->');
  const answer = page.locator('.message:not(.user)');
  const failure = answer.locator('.model-note.failed');
  await expect(failure).toContainText('WebGL 2 is unavailable');
  await expect(answer.locator('.model-canvas')).toHaveCount(0);
  await page.evaluate(() => ((window as any).denyWebGL = false));
  await failure.getByRole('button', { name: 'Retry' }).click();
  await expect(answer.getByLabel('3D model gl-0.glb')).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('the inline model leaves vertical swipes and the wheel to the chat', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = { toolu_touch: { models: [{ format: 'glb', data, bytes: 1 }] } };
  }, still);
  await page.goto('/');
  await chooseTestFolder(page);
  await reply(
    page,
    [{ id: 'touch', toolId: 'toolu_touch', count: 1 }],
    'Here.\n\n<!-- files:touch -->',
  );
  const answer = page.locator('.message:not(.user)');
  const inline = answer.getByLabel('3D model touch-0.glb');
  await expect(inline).toBeVisible();
  expect(await inline.evaluate((canvas) => canvas.style.touchAction)).toBe('pan-y');
  // The expanded view is the model's alone: every touch turns or zooms it.
  await answer.getByRole('button', { name: 'Expand touch-0.glb' }).click();
  const expanded = page.getByLabel('Model preview').getByLabel('3D model touch-0.glb');
  await expect(expanded).toBeVisible();
  expect(await expanded.evaluate((canvas) => canvas.style.touchAction)).toBe('none');
  // Its zoom buttons stay reachable from the keyboard, as the wheel is not.
  await expect(
    page.getByLabel('Model preview').getByRole('button', { name: 'Zoom in' }),
  ).toBeVisible();
  // The inline figure keeps its place in the chat while the preview is open.
  await expect(answer.locator('.model-view')).toBeVisible();
  await page.getByRole('button', { name: 'Close model preview' }).click();
  await expect(inline).toBeVisible();
  await expect(answer.getByRole('button', { name: 'Expand touch-0.glb' })).toBeFocused();
});

test('pausing holds the pose the animation reached, and playing continues from it', async ({
  page,
}) => {
  await page.goto('/');
  const times = await page.evaluate(async (data) => {
    // The dev server serves the module itself; the path is data here, not an import to resolve.
    const modulePath = '/src/lib/model-scene.ts';
    const { createModelScene } = await import(/* @vite-ignore */ modulePath);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width: 320px; height: 240px';
    document.body.append(canvas);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const scene = await createModelScene(canvas, bytes.buffer, 'glb', { playing: true });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(400);
    scene.setPlaying(false);
    const paused = scene.state().time;
    await wait(300);
    const held = scene.state().time;
    // Out of view the scene draws nothing, and its time stays where it was.
    scene.setPlaying(true);
    await wait(200);
    scene.setVisible(false);
    const hidden = scene.state().time;
    await wait(300);
    const stillHidden = scene.state().time;
    scene.setVisible(true);
    await wait(200);
    const resumed = scene.state().time;
    scene.dispose();
    return { paused, held, hidden, stillHidden, resumed };
  }, animated);
  expect(times.paused).toBeGreaterThan(0);
  expect(times.held).toBe(times.paused);
  expect(times.hidden).not.toBe(times.paused);
  expect(times.stillHidden).toBe(times.hidden);
  expect(times.resumed).not.toBe(times.hidden);
});

test('a structured-output reply shows the files it sent after its JSON', async ({ page }) => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = {
      toolu_chart: { images: [{ mediaType: 'image/png', data, bytes: 68, width: 1, height: 1 }] },
    };
  }, png);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await page
    .getByLabel('Structured output · JSON Schema')
    .fill(JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } } }));
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Chart it');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const result = JSON.stringify({ answer: 'Throughput levels off after ten workers.' });
  await page.evaluate((text) => {
    const w = window as any;
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'chart',
        revision: 1,
        runId: Object.keys(w.capabilityRuns)[0],
        toolId: 'toolu_chart',
        files: [
          { index: 0, name: 'chart.png', mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
        ],
      },
    });
    w.emitCapability({ kind: 'text', text });
    w.finishCapabilities('complete');
  }, result);
  const json = page.getByLabel('Structured output', { exact: true });
  await expect(json).toHaveText(result);
  const image = page.getByAltText('Image 1 returned by chart.png');
  await expect(image).toBeVisible();
  expect((await image.boundingBox())!.y).toBeGreaterThan((await json.boundingBox())!.y);
});

test('a model of any size opens whole on the computer that keeps it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = { toolu_large: { models: [{ format: 'glb', data, bytes: 1 }] } };
  }, still);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Show me the full model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'Here it is.\n\n<!-- files:large -->' });
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'large',
        revision: 1,
        runId: Object.keys(w.capabilityRuns)[0],
        toolId: 'toolu_large',
        files: [
          { index: 0, name: 'scan.glb', mediaType: 'model/gltf-binary', bytes: 300 * 1024 ** 2 },
        ],
      },
    });
    w.finishCapabilities('complete');
  });
  const answer = page.locator('.message:not(.user)');
  await expect(answer.getByLabel('3D model scan.glb')).toBeVisible();
  await expect(answer.getByText('GLB · 300 MB', { exact: true })).toBeVisible();
  await expect(answer.getByRole('slider')).toHaveCount(0);
  // Read raw from this computer's store, and only when its scene is built: too large to keep
  // between scenes, it is not read ahead.
  expect(await modelReads(page)).toBe(1);
  expect(
    await page.evaluate(() =>
      ((window as any).toolOutputCalls ?? []).some(
        (call: { command: string }) => call.command === 'read_tool_output_model',
      ),
    ),
  ).toBe(false);
});

test('views of a model start where the viewer starts and turn as dragging right does', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async (data) => {
    const modulePath = '/src/lib/model-scene.ts';
    const { renderModelViews } = await import(/* @vite-ignore */ modulePath);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const views = await renderModelViews(bytes.buffer, 'glb', {
      count: 8,
      width: 240,
      height: 160,
    });
    // How much of each view the model covers, read back from its pixels.
    const covered = [];
    for (const view of views) {
      const image = new Image();
      image.src = `data:${view.mediaType};base64,${view.data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) opaque++;
      covered.push(opaque / (pixels.length / 4));
    }
    return {
      views: views.map(({ mediaType, width, height, data }: any) => ({
        mediaType,
        width,
        height,
        data,
      })),
      covered,
    };
  }, still);
  expect(result.views).toHaveLength(8);
  for (const view of result.views)
    expect(view).toMatchObject({ mediaType: 'image/webp', width: 240, height: 160 });
  // The one-sided triangle faces the viewer's starting camera. Each view turns the camera 45°
  // as a drag to the right does, so views 1, 2 and 3 (of 8) and view 8 see its front, and the
  // four between see its back, which is not drawn.
  const front = [0, 1, 2, 7];
  for (const [index, covered] of result.covered.entries())
    if (front.includes(index)) expect(covered, `view ${index + 1}`).toBeGreaterThan(0.01);
    else expect(covered, `view ${index + 1}`).toBe(0);
  expect(new Set(front.map((index) => result.views[index].data)).size).toBe(4);
});
