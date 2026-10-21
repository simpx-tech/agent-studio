import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { rgbPng, triangleGlbBase64 } from './model-fixture';

/** Four flat quadrants, red, green, blue and yellow from the top left: one picture at any size. */
function quadrants(width: number, height: number) {
  const colours: [number, number, number][] = [
    [220, 40, 40],
    [40, 180, 60],
    [40, 80, 220],
    [230, 200, 30],
  ];
  return Buffer.from(
    rgbPng(width, height, (x, y) => colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]),
  ).toString('base64');
}

type Shown = { index: number; name: string; mediaType: string; bytes: number } & Record<
  string,
  unknown
>;
/** Sends a message and answers it with a comparison of `files`, placed between two paragraphs. */
async function compare(page: Page, files: Shown[], caption?: string) {
  await page.getByLabel('Message', { exact: true }).fill('Compare them');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(
    ({ files, caption }) => {
      const w = window as any;
      w.emitCapability({
        kind: 'text',
        text: 'Here they are side by side.\n\n<!-- files:pair -->\n\nThe right one is sharper.',
      });
      w.emitCapability({
        kind: 'sentfiles',
        sentFiles: {
          id: 'pair',
          revision: 1,
          runId: Object.keys(w.capabilityRuns)[0],
          toolId: 'toolu_pair',
          caption,
          compare: true,
          files,
        },
      });
      w.finishCapabilities('complete');
    },
    { files, caption },
  );
}

const small = quadrants(64, 48);
const large = quadrants(128, 96);
const images: Shown[] = [
  { index: 0, name: 'small.png', mediaType: 'image/png', bytes: 9000, width: 64, height: 48 },
  { index: 1, name: 'large.png', mediaType: 'image/png', bytes: 37000, width: 128, height: 96 },
];
async function showImages(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    ({ small, large }) => {
      (window as any).toolOutputs = {
        toolu_pair: {
          images: [
            { mediaType: 'image/png', data: small, bytes: 9000, width: 64, height: 48 },
            { mediaType: 'image/png', data: large, bytes: 37000, width: 128, height: 96 },
          ],
        },
      };
    },
    { small, large },
  );
  await page.goto('/');
  await chooseTestFolder(page);
  await compare(
    page,
    [
      { ...images[0], label: 'Before' },
      { ...images[1], label: 'After' },
    ],
    'Upscaled twice',
  );
}

/**
 * What an image pane shows, from the transform that places its picture: the point of the image
 * at the pane's centre, as shares of the image, and how many times the whole image it is zoomed.
 */
function region(pane: Locator) {
  return pane.evaluate((stage) => {
    const image = stage.querySelector('img')!;
    const [, x, y, scale] = image.style.transform
      .match(/translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/)!
      .map(Number);
    const width = parseFloat(image.style.width);
    const height = parseFloat(image.style.height);
    const { clientWidth: w, clientHeight: h } = stage as HTMLElement;
    return {
      x: (w / 2 - x) / scale / width,
      y: (h / 2 - y) / scale / height,
      zoom: scale / Math.min(w / width, h / height),
    };
  });
}
function expectSameRegion(
  a: { x: number; y: number; zoom: number },
  b: { x: number; y: number; zoom: number },
) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);
  expect(Math.abs(a.y - b.y)).toBeLessThan(0.01);
  expect(Math.abs(a.zoom - b.zoom)).toBeLessThan(0.01);
}

/** A touchpad pinch outward at a point, which the browser reports as a wheel with Ctrl held. */
async function pinch(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
}

test('compared images sit side by side at their marker and zoom and pan together until freed @webkit', async ({
  page,
}) => {
  await showImages(page);
  const reply = page.locator('.message:not(.user)');
  const before = reply.getByRole('img', { name: 'Image 1, Before' });
  const after = reply.getByRole('img', { name: 'Image 2, After' });
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  await expect(reply.getByText('Upscaled twice')).toBeVisible();
  await expect(reply.getByText('64 × 48 · 8.8 KB')).toBeVisible();
  // Side by side, between the paragraphs its marker separates, each filling a pane of one size.
  const [left, right] = [(await before.boundingBox())!, (await after.boundingBox())!];
  expect(Math.abs(left.y - right.y)).toBeLessThan(1);
  expect(Math.abs(left.width - right.width)).toBeLessThan(1);
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  const prose = reply.locator('.prose');
  expect((await prose.filter({ hasText: 'side by side' }).boundingBox())!.y).toBeLessThan(left.y);
  expect((await prose.filter({ hasText: 'sharper' }).boundingBox())!.y).toBeGreaterThan(left.y);
  // Each picture fills its pane, whatever its own size, so both show the whole scene alike.
  expectSameRegion(await region(before), { x: 0.5, y: 0.5, zoom: 1 });
  expectSameRegion(await region(after), { x: 0.5, y: 0.5, zoom: 1 });

  // Synced: a pinch on the red quarter of the small picture shows the large one's red quarter
  // too, at the same size.
  const views = reply.getByRole('radiogroup', { name: 'Views' });
  await expect(views.getByRole('radio', { name: 'Synced' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await pinch(page, left.x + left.width * 0.25, left.y + left.height * 0.25);
  const zoomed = await region(before);
  expect(zoomed.zoom).toBeGreaterThan(1.5);
  expect(zoomed.x).toBeLessThan(0.45);
  expectSameRegion(await region(after), zoomed);
  // Dragging pans both.
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(left.x + left.width / 2 - 60, left.y + left.height / 2 - 40, {
    steps: 6,
  });
  await page.mouse.up();
  const panned = await region(before);
  expect(panned.x).toBeGreaterThan(zoomed.x);
  expectSameRegion(await region(after), panned);

  // Free: each picture on its own. The large one zooms back out alone.
  await views.getByRole('radio', { name: 'Free' }).click();
  await expect(views.getByRole('radio', { name: 'Free' })).toHaveAttribute('aria-checked', 'true');
  await after.focus();
  await page.keyboard.press('0');
  expectSameRegion(await region(after), { x: 0.5, y: 0.5, zoom: 1 });
  expectSameRegion(await region(before), panned);
  // Synced again from the picture moved last.
  await views.getByRole('radio', { name: 'Synced' }).click();
  expectSameRegion(await region(before), { x: 0.5, y: 0.5, zoom: 1 });

  // The bar's buttons act on both: zoom in, then reset.
  await reply.getByRole('button', { name: 'Zoom in' }).click();
  const closer = await region(after);
  expect(closer.zoom).toBeCloseTo(1.25, 2);
  expectSameRegion(await region(before), closer);
  await reply.getByRole('button', { name: 'Reset views' }).click();
  expectSameRegion(await region(before), { x: 0.5, y: 0.5, zoom: 1 });
  expectSameRegion(await region(after), { x: 0.5, y: 0.5, zoom: 1 });

  // The plain wheel scrolls the chat past the panes; only a touchpad pinch zooms them.
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.wheel(0, 120);
  expectSameRegion(await region(after), { x: 0.5, y: 0.5, zoom: 1 });

  // On a phone the panes stay side by side.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(before).toBeVisible();
  const [narrowLeft, narrowRight] = [(await before.boundingBox())!, (await after.boundingBox())!];
  expect(Math.abs(narrowLeft.y - narrowRight.y)).toBeLessThan(1);
  expect(narrowLeft.width).toBeGreaterThan(120);
});

test('a comparison opens whole in the file viewer, which shares its mode @webkit', async ({
  page,
}) => {
  await showImages(page);
  const reply = page.locator('.message:not(.user)');
  await expect(reply.getByRole('img', { name: 'Image 2, After' })).toBeVisible();
  const preview = page.getByRole('dialog', { name: 'Comparison preview' });
  // A click on a picture opens the comparison, as a single picture opens, and so does Enter on
  // a picture with focus.
  await reply.getByRole('img', { name: 'Image 2, After' }).click();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await reply.getByRole('img', { name: 'Image 1, Before' }).focus();
  await page.keyboard.press('Enter');
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  const expand = reply.getByRole('button', { name: 'Expand comparison' });
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('Before vs After')).toBeVisible();
  await expect(preview.getByText('2 images')).toBeVisible();
  await expect(preview.getByText('Upscaled twice')).toBeVisible();
  const before = preview.getByRole('img', { name: 'Image 1, Before' });
  const after = preview.getByRole('img', { name: 'Image 2, After' });
  await expect(after).toBeVisible();
  // Side by side, each far larger than in the chat.
  const [left, right] = [(await before.boundingBox())!, (await after.boundingBox())!];
  expect(Math.abs(left.y - right.y)).toBeLessThan(1);
  expect(left.width).toBeGreaterThan(500);
  // The wheel zooms here, and the other pane follows.
  await page.mouse.move(left.x + left.width * 0.75, left.y + left.height * 0.75);
  await page.mouse.wheel(0, -300);
  const zoomed = await region(before);
  expect(zoomed.zoom).toBeGreaterThan(1.2);
  expectSameRegion(await region(after), zoomed);
  // The arrows choose a mode in the switch, never stepping to another file.
  const views = preview.getByRole('radiogroup', { name: 'Views' });
  await views.getByRole('radio', { name: 'Synced' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(views.getByRole('radio', { name: 'Free' })).toBeFocused();
  await expect(views.getByRole('radio', { name: 'Free' })).toHaveAttribute('aria-checked', 'true');
  await expect(preview.getByText('Before vs After')).toBeVisible();
  // The chat's comparison takes the mode chosen here, and Escape returns to Expand.
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(expand).toBeFocused();
  await expect(
    reply.getByRole('radiogroup', { name: 'Views' }).getByRole('radio', { name: 'Free' }),
  ).toHaveAttribute('aria-checked', 'true');
  // The saved reply keeps the comparison and labels, and never the pictures.
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace') ?? '');
  expect(saved).toContain('"compare":true');
  expect(saved).toContain('"label":"After"');
  expect(saved).not.toContain(large.slice(0, 40));
});

test('an image that arrives after the other was zoomed shows what the other shows', async ({
  page,
}) => {
  // The second picture's read waits until the first one has been zoomed.
  await page.addInitScript(() => {
    (window as any).holdToolOutputWhen = (command: string, args: { index: number }) =>
      command === 'read_tool_output_image' && args.index === 1;
  });
  await showImages(page);
  const reply = page.locator('.message:not(.user)');
  const before = reply.getByRole('img', { name: 'Image 1, Before' });
  await expect(before).toBeVisible();
  await expect(reply.getByText('Loading image…')).toBeVisible();
  const box = (await before.boundingBox())!;
  await pinch(page, box.x + box.width * 0.7, box.y + box.height * 0.3);
  const zoomed = await region(before);
  expect(zoomed.zoom).toBeGreaterThan(1.5);
  await page.evaluate(() => {
    const w = window as any;
    w.holdToolOutputWhen = undefined;
    w.releaseToolOutput();
  });
  const after = reply.getByRole('img', { name: 'Image 2, After' });
  await expect(after).toBeVisible();
  await expect.poll(async () => (await region(after)).zoom).toBeGreaterThan(1.5);
  expectSameRegion(await region(after), zoomed);
});

test('four compared images take two rows of two, and all four stay synced @webkit', async ({
  page,
}) => {
  const sizes = [
    [64, 48],
    [128, 96],
    [96, 72],
    [32, 24],
  ];
  const labels = ['Original', 'Upscaled', 'Sharpened', 'Denoised'];
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    (images) => {
      (window as any).toolOutputs = { toolu_pair: { images } };
    },
    sizes.map(([width, height]) => ({
      mediaType: 'image/png',
      data: quadrants(width, height),
      bytes: 1000,
      width,
      height,
    })),
  );
  await page.goto('/');
  await chooseTestFolder(page);
  await compare(
    page,
    sizes.map(([width, height], index) => ({
      index,
      name: `texture-${index}.png`,
      mediaType: 'image/png',
      bytes: 1000,
      width,
      height,
      label: labels[index],
    })),
  );
  const reply = page.locator('.message:not(.user)');
  const panes = labels.map((label, index) =>
    reply.getByRole('img', { name: `Image ${index + 1}, ${label}` }),
  );
  await expect(panes[3]).toBeVisible();
  /** Each pane's place: two rows of two, every pane the same size. */
  async function grid() {
    const boxes = await Promise.all(panes.map(async (pane) => (await pane.boundingBox())!));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(1);
    expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(1);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
    expect(Math.abs(boxes[0].x - boxes[2].x)).toBeLessThan(1);
    for (const box of boxes) expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1);
    return boxes;
  }
  const [first] = await grid();
  // Half the comparison's width each, where four in one row left a quarter.
  const width = (await reply.locator('.compare-view').boundingBox())!.width;
  expect(first.width).toBeGreaterThan(width * 0.45);
  // A pinch on one zooms all four to the same region, whatever their sizes.
  const third = (await panes[2].boundingBox())!;
  await pinch(page, third.x + third.width * 0.3, third.y + third.height * 0.7);
  const zoomed = await region(panes[2]);
  expect(zoomed.zoom).toBeGreaterThan(1.5);
  for (const pane of [panes[0], panes[1], panes[3]]) expectSameRegion(await region(pane), zoomed);
  // The file viewer shows them two by two at full size.
  await reply.getByRole('button', { name: 'Expand comparison' }).click();
  const preview = page.getByRole('dialog', { name: 'Comparison preview' });
  await expect(preview.getByText('4 images')).toBeVisible();
  const expanded = await Promise.all(
    labels.map(
      async (label, index) =>
        (await preview.getByRole('img', { name: `Image ${index + 1}, ${label}` }).boundingBox())!,
    ),
  );
  expect(Math.abs(expanded[0].y - expanded[1].y)).toBeLessThan(1);
  expect(expanded[2].y).toBeGreaterThan(expanded[0].y + expanded[0].height - 1);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  // On a phone too.
  await page.setViewportSize({ width: 390, height: 844 });
  await panes[0].scrollIntoViewIfNeeded();
  await grid();
});

const still = triangleGlbBase64({ animated: false });
const animated = triangleGlbBase64();
async function showModels(page: Page, data: [string, string]) {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = {
      toolu_pair: { models: data.map((model) => ({ format: 'glb', data: model, bytes: 1 })) },
    };
  }, data);
  await page.goto('/');
  await chooseTestFolder(page);
  await compare(page, [
    { index: 0, name: 'before.glb', mediaType: 'model/gltf-binary', bytes: 220, label: 'Before' },
    { index: 1, name: 'after.glb', mediaType: 'model/gltf-binary', bytes: 220, label: 'After' },
  ]);
}

test('synced models turn, move and zoom as one, and freed ones each on their own', async ({
  page,
}) => {
  // One model on both sides, so equal views draw equal pictures.
  await showModels(page, [still, still]);
  const reply = page.locator('.message:not(.user)');
  const before = reply.getByLabel('3D model before.glb');
  const after = reply.getByLabel('3D model after.glb');
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  // The stage's gradient is dithered differently from one frame to the next.
  await page.addStyleTag({ content: '.model-stage { background: none !important; }' });
  /** Both pictures, once the views stop gliding. */
  async function drawn() {
    let last: [Buffer, Buffer] | undefined;
    for (;;) {
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const next: [Buffer, Buffer] = [await before.screenshot(), await after.screenshot()];
      if (last && last[0].equals(next[0]) && last[1].equals(next[1])) return next;
      last = next;
      await page.waitForTimeout(150);
    }
  }
  /**
   * Whether two pictures show one view. A pane taking another's view goes through the controls'
   * spherical coordinates, which can move its camera by a rounding error and flip an edge pixel
   * or two; a view that drifted, as before a glide's resting view was passed on, moved 193.
   */
  async function alike(a: Buffer, b: Buffer) {
    const differing = await page.evaluate(
      async ([a, b]) => {
        const pixels = async (data: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [x, y] = [await pixels(a), await pixels(b)];
        if (x.length !== y.length) return Infinity;
        let count = 0;
        for (let i = 0; i < x.length; i += 4)
          if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) count++;
        return count;
      },
      [a.toString('base64'), b.toString('base64')],
    );
    return differing <= 6;
  }
  async function drag(canvas: Locator, by: number) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + by, box.y + box.height / 2 + by / 3, {
      steps: 8,
    });
    await page.mouse.up();
  }
  const [start] = await drawn();
  // Synced: turning the left one turns the right one the same way.
  await drag(before, 90);
  const [turnedLeft, turnedRight] = await drawn();
  expect(turnedLeft.equals(start)).toBe(false);
  expect(await alike(turnedRight, turnedLeft)).toBe(true);
  // So do moving it, with the right button, and the bar's zoom.
  const box = (await after.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await reply.getByRole('button', { name: 'Zoom in' }).click();
  const [movedLeft, movedRight] = await drawn();
  expect(movedLeft.equals(turnedLeft)).toBe(false);
  expect(await alike(movedRight, movedLeft)).toBe(true);

  // Free: the left one turns alone.
  await reply.getByRole('radio', { name: 'Free' }).click();
  await drag(before, -120);
  const [freeLeft, freeRight] = await drawn();
  expect(freeLeft.equals(movedLeft)).toBe(false);
  expect(freeRight.equals(movedRight)).toBe(true);
  // Synced again, the right one takes the left one's view, the one moved last.
  await reply.getByRole('radio', { name: 'Synced' }).click();
  const [syncedLeft, syncedRight] = await drawn();
  expect(syncedLeft.equals(freeLeft)).toBe(true);
  expect(await alike(syncedRight, freeLeft)).toBe(true);
  // Reset brings both back to the start, still as one.
  await reply.getByRole('button', { name: 'Reset views' }).click();
  const [resetLeft, resetRight] = await drawn();
  expect(resetLeft.equals(start)).toBe(true);
  expect(await alike(resetRight, start)).toBe(true);
  await expect(reply.locator('.model-note.failed')).toHaveCount(0);
});

test('a comparison of models opens in the file viewer while the chat gives its scenes up', async ({
  page,
}) => {
  await showModels(page, [still, animated]);
  const reply = page.locator('.message:not(.user)');
  await expect(reply.getByLabel('3D model after.glb')).toBeVisible();
  // One control plays and pauses every animated model, and the light is the window's.
  await expect(reply.getByRole('button', { name: 'Pause animations' })).toBeVisible();
  await expect(reply.getByRole('combobox', { name: 'Lighting' })).toHaveText('Studio');
  await reply.getByRole('button', { name: 'Pause animations' }).click();
  await expect(reply.getByRole('button', { name: 'Play animations' })).toBeVisible();
  await reply.getByRole('button', { name: 'Expand comparison' }).click();
  const preview = page.getByRole('dialog', { name: 'Comparison preview' });
  await expect(preview.getByLabel('3D model before.glb')).toBeVisible();
  await expect(preview.getByLabel('3D model after.glb')).toBeVisible();
  await expect(preview.getByText('2 models')).toBeVisible();
  // The paused animation stays paused here, and the chat holds no scene meanwhile.
  await expect(preview.getByRole('button', { name: 'Play animations' })).toBeVisible();
  await expect(reply.locator('.model-canvas')).toHaveCount(0);
  // The expanded scenes take every touch, as a model's expanded view does.
  expect(
    await preview.getByLabel('3D model before.glb').evaluate((canvas) => canvas.style.touchAction),
  ).toBe('none');
  await page.getByRole('button', { name: 'Close comparison preview' }).click();
  await expect(preview).toBeHidden();
  await expect(reply.getByLabel('3D model before.glb')).toBeVisible();
  await expect(reply.getByLabel('3D model after.glb')).toBeVisible();
  expect(
    await reply.getByLabel('3D model before.glb').evaluate((canvas) => canvas.style.touchAction),
  ).toBe('pan-y');
  await expect(reply.locator('.model-note.failed')).toHaveCount(0);
});

test('an image beside a model has no mode to choose, and keeps its own view', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    ({ small, still }) => {
      (window as any).toolOutputs = {
        toolu_pair: {
          images: [{ mediaType: 'image/png', data: small, bytes: 9000, width: 64, height: 48 }],
          models: [{ format: 'glb', data: still, bytes: 1 }],
        },
      };
    },
    { small, still },
  );
  await page.goto('/');
  await chooseTestFolder(page);
  await compare(page, [
    { ...images[0], label: 'Reference' },
    { index: 0, name: 'result.glb', mediaType: 'model/gltf-binary', bytes: 220 },
  ]);
  const reply = page.locator('.message:not(.user)');
  await expect(reply.getByRole('img', { name: 'Image 1, Reference' })).toBeVisible();
  await expect(reply.getByLabel('3D model result.glb')).toBeVisible();
  // Without a label, a pane is named by its file.
  await expect(reply.getByText('result.glb', { exact: true })).toBeVisible();
  await expect(reply.getByRole('radiogroup', { name: 'Views' })).toHaveCount(0);
  await reply.getByRole('button', { name: 'Expand comparison' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Comparison preview' }).getByText('1 image · 1 model'),
  ).toBeVisible();
});
