import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { triangleGlbBase64 } from './model-fixture';

/**
 * Files a chat's replies show are connected: consecutive images form one gallery, and the
 * viewer steps through every image and model of the conversation in order, with arrows, keys
 * and swipes, zooming and panning images as it goes.
 */
type Shown = { name: string; mediaType: string; width?: number; height?: number };
type Group = { id: string; toolId: string; caption?: string; files: Shown[] };

/** Draws numbered pictures in the page and keeps them, with models, as the mock host's results. */
async function keepFiles(
  page: Page,
  outputs: Record<string, { images?: [number, number][]; models?: string[] }>,
) {
  await page.evaluate((outputs) => {
    let count = 0;
    const kept: Record<string, unknown> = {};
    for (const [toolId, { images = [], models = [] }] of Object.entries(outputs)) {
      kept[toolId] = {
        images: images.map(([width, height]) => {
          count++;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d')!;
          context.fillStyle = `hsl(${(count * 67) % 360} 45% 40%)`;
          context.fillRect(0, 0, width, height);
          context.strokeStyle = 'white';
          context.lineWidth = 8;
          context.strokeRect(40, 40, width - 80, height - 80);
          context.fillStyle = 'white';
          context.font = `${Math.round(height / 3)}px sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(String(count), width / 2, height / 2);
          const data = canvas.toDataURL('image/png').split(',')[1];
          return { mediaType: 'image/png', data, bytes: data.length, width, height };
        }),
        models: models.map((data) => ({ format: 'glb', data, bytes: 220 })),
      };
    }
    (window as any).toolOutputs = kept;
  }, outputs);
}

/** Sends `prompt` and answers it with `text`, showing each group; `turn` counts the replies. */
async function reply(page: Page, prompt: string, groups: Group[], text: string, turn: number) {
  await page.getByLabel('Message', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(
    (turn) => Object.keys((window as any).capabilityRuns ?? {}).length === turn,
    turn,
  );
  await page.evaluate(
    ({ groups, text }) => {
      const w = window as any;
      const runId = Object.keys(w.capabilityRuns).at(-1);
      w.emitCapability({ kind: 'text', text });
      for (const group of groups) {
        const numbers = { image: 0, model: 0 };
        w.emitCapability({
          kind: 'sentfiles',
          sentFiles: {
            id: group.id,
            revision: 1,
            runId,
            toolId: group.toolId,
            caption: group.caption,
            files: group.files.map((file) => ({
              ...file,
              index: numbers[file.mediaType.startsWith('model/') ? 'model' : 'image']++,
              bytes: 220,
            })),
          },
        });
      }
      w.finishCapabilities('complete');
    },
    { groups, text },
  );
}

const screens = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `screen-${index}.png`,
    mediaType: 'image/png',
    width: 1440,
    height: 900,
  }));
const transform = (image: ReturnType<Page['locator']>) =>
  image.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
const percent = async (level: ReturnType<Page['locator']>) =>
  Number((await level.textContent())?.replace('%', ''));

test('consecutive images form one gallery, and the viewer steps through every file of the chat', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await keepFiles(page, {
    toolu_screens: { images: Array(5).fill([1440, 900]) },
    toolu_figure: { models: [triangleGlbBase64()] },
    toolu_poster: { images: [[800, 1000]] },
  });
  await chooseTestFolder(page);
  await reply(
    page,
    'Show me the screens',
    [{ id: 'screens', toolId: 'toolu_screens', caption: 'The five screens', files: screens(5) }],
    'Here are the screens.\n\n<!-- files:screens -->\n\nThat is all of them.',
    1,
  );
  const first = page.getByTestId('message').filter({ hasText: 'Here are the screens' });
  const gallery = first.getByRole('group', { name: '5 images' });
  const tiles = gallery.getByRole('button', { name: /^Open image/ });
  await expect(tiles).toHaveCount(5);
  await expect(first.getByText('The five screens')).toBeVisible();
  // Rows of two and three, each at one height, both filling the gallery's width.
  const boxes = await Promise.all(
    (await tiles.all()).map(async (tile) => (await tile.boundingBox())!),
  );
  const right = (box: { x: number; width: number }) => box.x + box.width;
  for (const [a, b] of [
    [0, 1],
    [2, 3],
    [3, 4],
  ]) {
    expect(Math.abs(boxes[a].y - boxes[b].y)).toBeLessThan(1);
    expect(Math.abs(boxes[a].height - boxes[b].height)).toBeLessThan(1);
  }
  expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
  expect(Math.abs(right(boxes[1]) - right(boxes[4]))).toBeLessThan(1.5);
  expect((await gallery.boundingBox())!.height).toBeLessThan(520);

  await reply(
    page,
    'And the figure',
    [
      {
        id: 'figure',
        toolId: 'toolu_figure',
        files: [{ name: 'figure.glb', mediaType: 'model/gltf-binary' }],
      },
      {
        id: 'poster',
        toolId: 'toolu_poster',
        caption: 'The poster',
        files: [{ name: 'poster.png', mediaType: 'image/png', width: 800, height: 1000 }],
      },
    ],
    'The figure turns.\n\n<!-- files:figure -->\n\nAnd the poster:\n\n<!-- files:poster -->',
    2,
  );
  const second = page.getByTestId('message').filter({ hasText: 'The figure turns' });
  const inline = second.getByLabel('3D model figure.glb');
  await expect(inline).toBeVisible();
  // The inline model takes the reply's whole width.
  expect((await inline.boundingBox())!.width).toBeGreaterThan(600);

  await tiles.nth(1).click();
  const images = page.getByRole('dialog', { name: 'Image preview' });
  const models = page.getByRole('dialog', { name: 'Model preview' });
  await expect(images).toContainText('screen-1.png');
  await expect(images).toContainText('2 of 7');
  await expect(images).toContainText('The five screens');
  await expect(images.getByAltText('Full size screen-1.png')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(images).toContainText('3 of 7');
  await images.getByRole('button', { name: 'Next file' }).click();
  await images.getByRole('button', { name: 'Next file' }).click();
  await expect(images).toContainText('screen-4.png');
  // The next reply's model opens in its full viewer; the inline one gives its scene up.
  await images.getByRole('button', { name: 'Next file' }).click();
  await expect(models.getByLabel('3D model figure.glb')).toBeVisible();
  await expect(models).toContainText('6 of 7');
  await expect(second.locator('.model-view .model-canvas')).toHaveCount(0);
  await models.getByRole('button', { name: 'Next file' }).click();
  await expect(images).toContainText('poster.png');
  await expect(images).toContainText('The poster');
  // The last file has no next one.
  const next = images.getByRole('button', { name: 'Next file' });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(images).toContainText('7 of 7');
  await page.keyboard.press('ArrowLeft');
  await expect(models).toContainText('6 of 7');
  // Closing returns to the tile that opened the viewer, and the inline model draws again
  // once it is back on screen.
  await page.keyboard.press('Escape');
  await expect(models).toBeHidden();
  await expect(tiles.nth(1)).toBeFocused();
  await second.locator('.model-stage').scrollIntoViewIfNeeded();
  await expect(inline).toBeVisible();
});

test('an opened image zooms where the wheel turns, pans when dragged, and fits again', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await keepFiles(page, {
    toolu_pair: {
      images: [
        [1440, 900],
        [1440, 900],
      ],
    },
  });
  await chooseTestFolder(page);
  await reply(
    page,
    'Show me both',
    [{ id: 'pair', toolId: 'toolu_pair', files: screens(2) }],
    'Both screens:\n\n<!-- files:pair -->',
    1,
  );
  const answer = page.getByTestId('message').filter({ hasText: 'Both screens' });
  await answer.getByRole('button', { name: /^Open image 1/ }).click();
  const viewer = page.getByRole('dialog', { name: 'Image preview' });
  const image = viewer.getByAltText('Full size screen-0.png');
  await expect(image).toBeVisible();
  const level = viewer.getByTitle(/^Zoom, as a share/);
  const fit = await percent(level);
  expect(fit).toBeLessThan(100);
  const stage = (await viewer.locator('.zoom-stage').boundingBox())!;

  // The image point under the pointer stays under it as the wheel zooms in.
  const at = { x: stage.x + stage.width * 0.3, y: stage.y + stage.height * 0.4 };
  const before = await transform(image);
  const point = {
    x: (at.x - stage.x - before.x) / before.scale,
    y: (at.y - stage.y - before.y) / before.scale,
  };
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => percent(level)).toBeGreaterThan(fit);
  const zoomed = await transform(image);
  // Wheel events carry whole pixels, so the point may land up to one away.
  expect(Math.abs(stage.x + zoomed.x + point.x * zoomed.scale - at.x)).toBeLessThan(1.5);
  expect(Math.abs(stage.y + zoomed.y + point.y * zoomed.scale - at.y)).toBeLessThan(1.5);

  // Dragging pans it, and the arrow keys pan a zoomed image instead of stepping.
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 60, { steps: 4 });
  await page.mouse.up();
  const dragged = await transform(image);
  expect(dragged.x).toBeGreaterThan(zoomed.x + 100);
  expect(dragged.y).toBeGreaterThan(zoomed.y + 40);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await transform(image)).x).toBeLessThan(dragged.x);
  await expect(viewer).toContainText('1 of 2');

  // A double click, the buttons and the keys return to the whole image or its own pixels.
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => percent(level)).toBe(fit);
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => percent(level)).toBeGreaterThan(fit);
  await viewer.getByRole('button', { name: 'Fit to window' }).click();
  await expect.poll(() => percent(level)).toBe(fit);
  await viewer.getByRole('button', { name: 'Actual size' }).click();
  await expect(level).toHaveText('100%');
  await page.keyboard.press('0');
  await expect.poll(() => percent(level)).toBe(fit);

  // At the whole image, a swipe steps to the next file.
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 - 220, stage.y + stage.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(viewer).toContainText('2 of 2');
  await expect(viewer.getByAltText('Full size screen-1.png')).toBeVisible();
});

test('single images sent one call at a time join one gallery, each keeping its caption', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await keepFiles(page, {
    toolu_one: { images: [[1440, 900]] },
    toolu_two: { images: [[1440, 900]] },
    toolu_three: { images: [[1440, 900]] },
    toolu_four: { images: [[900, 900]] },
  });
  await chooseTestFolder(page);
  const lone = (id: string, caption: string, width = 1440, height = 900): Group => ({
    id,
    toolId: `toolu_${id}`,
    caption,
    files: [{ name: `${id}.png`, mediaType: 'image/png', width, height }],
  });
  await reply(
    page,
    'Take the shots',
    [
      lone('one', 'Home'),
      lone('two', 'Settings'),
      lone('three', 'Profile'),
      lone('four', 'The icon', 900, 900),
    ],
    'Three shots:\n\n<!-- files:one -->\n\n<!-- files:two -->\n\n<!-- files:three -->\n\nAnd apart from them:\n\n<!-- files:four -->',
    1,
  );
  const answer = page.getByTestId('message').filter({ hasText: 'Three shots' });
  const gallery = answer.getByRole('group', { name: '3 images' });
  await expect(gallery.getByRole('button', { name: /^Open image/ })).toHaveCount(3);
  await expect(gallery.locator('.gallery-caption')).toHaveText(['Home', 'Settings', 'Profile']);
  // Prose between groups keeps them apart: the fourth stands alone with its caption.
  await expect(answer.locator('.sent-gallery')).toHaveCount(1);
  await expect(answer.locator('figcaption').filter({ hasText: 'The icon' })).toBeVisible();
  await gallery
    .getByRole('button', { name: /^Open image/ })
    .nth(1)
    .click();
  const viewer = page.getByRole('dialog', { name: 'Image preview' });
  await expect(viewer).toContainText('two.png');
  await expect(viewer).toContainText('2 of 4');
  await expect(viewer.locator('.file-viewer-caption')).toHaveText('Settings');
});
