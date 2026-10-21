import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import {
  texturedGlbBase64,
  texturedGlbTexels,
  triangleGlb,
  triangleGlbBase64,
} from './model-fixture';

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

test('Shift with the arrow keys moves a focused model, and Home brings it back', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    (window as any).toolOutputs = { toolu_keys: { models: [{ format: 'glb', data, bytes: 1 }] } };
  }, still);
  await page.goto('/');
  await chooseTestFolder(page);
  await reply(
    page,
    [{ id: 'keys', toolId: 'toolu_keys', count: 1 }],
    'Here.\n\n<!-- files:keys -->',
  );
  const model = page.locator('.message:not(.user)').getByLabel('3D model keys-0.glb');
  await expect(model).toBeVisible();
  await expect(model).toHaveAttribute('aria-keyshortcuts', /Shift\+ArrowRight/);
  // The stage's gradient is dithered differently from one frame to the next.
  await page.addStyleTag({ content: '.model-stage { background: none !important; }' });
  await model.focus();
  /** The model as drawn, two frames on, so the frame the scene asked for before has drawn. */
  async function drawn() {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    return model.screenshot();
  }
  const start = await drawn();
  await page.keyboard.press('Shift+ArrowRight');
  const moved = await drawn();
  expect(moved.equals(start)).toBe(false);
  await page.keyboard.press('Home');
  expect((await drawn()).equals(start)).toBe(true);
  // Without Shift the same key turns it instead.
  await page.keyboard.press('ArrowRight');
  const turned = await drawn();
  expect(turned.equals(start)).toBe(false);
  expect(turned.equals(moved)).toBe(false);
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

test('the right button, Shift and two fingers move a model, as far beyond it as the reader goes', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async (data) => {
    const modulePath = '/src/lib/model-scene.ts';
    const { createModelScene } = await import(/* @vite-ignore */ modulePath);
    const canvas = document.createElement('canvas');
    // Above the page, where the pointer reaches it, in the inline view's shape and touch rule.
    canvas.style.cssText =
      'position: fixed; left: 0; top: 0; width: 400px; height: 250px; z-index: 2147483647';
    document.body.append(canvas);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    (window as any).scene = await createModelScene(canvas, bytes.buffer, 'glb');
  }, still);
  type State = { position: number[]; target: number[] };
  /**
   * Where the camera is once the view stops gliding. The controls stop a glide with up to 2% of
   * the view still to go, which the next move carries.
   */
  const settled = () =>
    page.evaluate(async () => {
      const scene = (window as any).scene;
      let last = '';
      while (JSON.stringify(scene.state()) !== last) {
        last = JSON.stringify(scene.state());
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return JSON.parse(last) as State;
    });
  const sub = (a: number[], b: number[]) => a.map((value, i) => value - b[i]);
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const length = (a: number[]) => Math.hypot(...a);
  const unit = (a: number[]) => a.map((value) => value / length(a));
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const offset = (state: State) => sub(state.position, state.target);
  const start = await settled();
  expect(length(start.target)).toBe(0);
  // The camera's right and up, and how tall its 45° view is where it looks.
  const forward = unit(sub(start.target, start.position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const height = 2 * length(offset(start)) * Math.tan(Math.PI / 8);
  /** How far the view moved right and up, as shares of its height, turning and zooming none. */
  const moved = (from: State, to: State) => {
    expect(length(sub(offset(to), offset(from)))).toBeLessThan(1e-6);
    const by = sub(to.target, from.target);
    return [dot(by, right) / height, dot(by, up) / height];
  };
  async function drag(from: [number, number], to: [number, number], button?: 'right') {
    await page.mouse.move(...from);
    await page.mouse.down({ button });
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up({ button });
  }

  // The model follows the pointer, so the view moves the other way by the share dragged.
  await drag([200, 125], [280, 125], 'right');
  const dragged = await settled();
  let [x, y] = moved(start, dragged);
  expect(Math.abs(x + 80 / 250)).toBeLessThan(0.03);
  expect(Math.abs(y)).toBeLessThan(0.02);
  await page.keyboard.down('Shift');
  await drag([200, 100], [200, 150]);
  await page.keyboard.up('Shift');
  const shifted = await settled();
  [x, y] = moved(dragged, shifted);
  expect(Math.abs(x)).toBeLessThan(0.02);
  expect(Math.abs(y - 50 / 250)).toBeLessThan(0.03);
  // Two fingers moving sideways move it too, where one finger turns it and the chat keeps
  // vertical swipes.
  const touch = await page.context().newCDPSession(page);
  const fingers = (at: number) => [
    { x: at, y: 110, id: 1 },
    { x: at, y: 140, id: 2 },
  ];
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(240) });
  for (let at = 230; at >= 160; at -= 10)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(at) });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const swiped = await settled();
  [x, y] = moved(shifted, swiped);
  expect(x).toBeGreaterThan(0.2);
  expect(x).toBeLessThan(80 / 250 + 0.03);
  expect(Math.abs(y)).toBeLessThan(0.02);

  // Reset returns to the start even while the view still glides from a drag.
  await drag([200, 125], [120, 160], 'right');
  await page.evaluate(() => (window as any).scene.reset());
  const reset = await settled();
  expect(length(reset.target)).toBeLessThan(1e-9);
  expect(length(sub(reset.position, start.position))).toBeLessThan(1e-9);

  // The point the view turns around goes past the model's reach, half its diagonal here, as
  // far as the reader drags it, and a drag back moves the view at once.
  await drag([20, 125], [380, 125], 'right');
  const far = await settled();
  expect(length(far.target)).toBeGreaterThan(Math.SQRT1_2 * 2);
  await drag([300, 125], [260, 125], 'right');
  [x] = moved(far, await settled());
  expect(x).toBeGreaterThan(40 / 250 - 0.03);

  // Keys move by a share of the view, a tenth of its width here, and zoom keeps that point.
  const keyed = await page.evaluate(() => {
    const scene = (window as any).scene;
    scene.reset();
    scene.pan(0.1, 0);
    const moved = scene.state();
    scene.zoom(0.8);
    const zoomed = scene.state();
    scene.pan(1000, 0);
    return { moved, zoomed, far: scene.state() };
  });
  [x, y] = moved(start, keyed.moved);
  expect(x).toBeCloseTo(0.16, 9);
  expect(y).toBeCloseTo(0, 9);
  expect(length(sub(keyed.zoomed.target, keyed.moved.target))).toBeLessThan(1e-9);
  expect(length(offset(keyed.zoomed)) / length(offset(keyed.moved))).toBeCloseTo(0.8, 9);
  // Only so far that Reset can always find the model: fifty times its reach.
  expect(length(keyed.far.target)).toBeCloseTo(50 * Math.SQRT1_2, 6);
});

test('the wheel zooms to the very point under the pointer, as deep as any detail, and a double click flies there @webkit', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async (data) => {
    const modulePath = '/src/lib/model-scene.ts';
    const { createModelScene } = await import(/* @vite-ignore */ modulePath);
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position: fixed; left: 0; top: 0; width: 400px; height: 250px; z-index: 2147483647';
    document.body.append(canvas);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    (window as any).scene = await createModelScene(canvas, bytes.buffer, 'glb', {
      wheelZoom: true,
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, still);
  type View = { position: number[]; target: number[] };
  const sub = (a: number[], b: number[]) => a.map((value, i) => value - b[i]);
  const add = (a: number[], b: number[]) => a.map((value, i) => value + b[i]);
  const scale = (a: number[], by: number) => a.map((value) => value * by);
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const length = (a: number[]) => Math.hypot(...a);
  const unit = (a: number[]) => scale(a, 1 / length(a));
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  // The camera's 45° view on the 400 × 250 canvas, as three.js projects through it.
  const tangent = Math.tan(Math.PI / 8);
  const aspect = 400 / 250;
  const basis = (view: View) => {
    const forward = unit(sub(view.target, view.position));
    const right = unit(cross(forward, [0, 1, 0]));
    return { forward, right, up: cross(right, forward) };
  };
  /** Where a point of the scene stands on the canvas, in pixels. */
  const project = (view: View, point: number[]) => {
    const { forward, right, up } = basis(view);
    const v = sub(point, view.position);
    const depth = dot(v, forward);
    const x = dot(v, right) / (depth * tangent * aspect);
    const y = dot(v, up) / (depth * tangent);
    return [((x + 1) / 2) * 400, ((1 - y) / 2) * 250];
  };
  /** The point of the triangle's plane (z = 0) under a canvas pixel. */
  const under = (view: View, [px, py]: number[]) => {
    const { forward, right, up } = basis(view);
    const x = (px / 400) * 2 - 1;
    const y = 1 - (py / 250) * 2;
    const ray = add(forward, add(scale(right, x * tangent * aspect), scale(up, y * tangent)));
    return add(view.position, scale(ray, -view.position[2] / ray[2]));
  };
  const wheel = (x: number, y: number, deltaY: number, times = 1) =>
    page.evaluate(
      ({ x, y, deltaY, times }) => {
        const canvas = document.querySelector('canvas')!;
        for (let i = 0; i < times; i++)
          canvas.dispatchEvent(
            new WheelEvent('wheel', {
              clientX: x,
              clientY: y,
              deltaY,
              bubbles: true,
              cancelable: true,
            }),
          );
        return (window as any).scene.view() as View;
      },
      { x, y, deltaY, times },
    );
  const start = (await page.evaluate(() => (window as any).scene.view())) as View;
  // A point of the triangle, below and left of the middle: its own surface, not the point the
  // view turns around, stays under the pointer as the wheel zooms in.
  const pointer = [176, 150];
  const spot = under(start, pointer);
  expect(spot[0] + spot[1]).toBeLessThan(0);
  const closer = await wheel(pointer[0], pointer[1], -300);
  expect(length(sub(closer.position, closer.target))).toBeCloseTo(
    length(sub(start.position, start.target)) * Math.exp(-300 * 0.0022),
    6,
  );
  const [x, y] = project(closer, spot);
  expect(Math.abs(x - pointer[0])).toBeLessThan(1);
  expect(Math.abs(y - pointer[1])).toBeLessThan(1);
  // Far deeper than a thousandth of the model, down to a hundred-thousandth, and still there.
  const deep = await wheel(pointer[0], pointer[1], -300, 40);
  expect(length(sub(deep.position, deep.target))).toBeLessThan(2e-5);
  const [dx, dy] = project(deep, spot);
  expect(Math.abs(dx - pointer[0])).toBeLessThan(2);
  expect(Math.abs(dy - pointer[1])).toBeLessThan(2);
  // And out again, until the model is a speck.
  const away = await wheel(pointer[0], pointer[1], 300, 80);
  expect(length(sub(away.position, away.target))).toBeGreaterThan(30);

  // A double click on the triangle takes the view there, turning around that point, closer.
  await page.evaluate(() => (window as any).scene.reset());
  const point = under(start, pointer);
  await page.mouse.dblclick(pointer[0], pointer[1]);
  await expect
    .poll(async () => {
      const view = (await page.evaluate(() => (window as any).scene.view())) as View;
      return length(sub(view.target, point));
    })
    .toBeLessThan(0.02);
  const flown = (await page.evaluate(() => (window as any).scene.view())) as View;
  expect(length(sub(flown.position, flown.target))).toBeCloseTo(
    length(sub(start.position, start.target)) / 2,
    2,
  );
  // A double click beside the model leaves the view where it is.
  await page.mouse.dblclick(390, 10);
  const unmoved = (await page.evaluate(() => (window as any).scene.view())) as View;
  expect(length(sub(unmoved.target, flown.target))).toBeLessThan(1e-9);
});

test('the light chosen on one model lights every model, and stays chosen after a reload', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript((data) => {
    const model = { format: 'glb', data, bytes: 1 };
    (window as any).toolOutputs = { toolu_lit: { models: [model, model] } };
  }, still);
  await page.goto('/');
  await chooseTestFolder(page);
  await reply(page, [{ id: 'lit', toolId: 'toolu_lit', count: 2 }], 'Two.\n\n<!-- files:lit -->');
  const answer = page.locator('.message:not(.user)');
  await expect(answer.getByLabel('3D model lit-1.glb')).toBeVisible();
  const pickers = answer.getByRole('combobox', { name: 'Lighting' });
  await expect(pickers).toHaveText(['Studio', 'Studio']);
  await pickers.first().click();
  await expect(page.getByRole('option')).toHaveText(['Studio', 'Flat', 'Realistic']);
  await page.getByRole('option', { name: 'Flat' }).click();
  await expect(pickers).toHaveText(['Flat', 'Flat']);
  // The expanded view takes it too, and a choice there lights the models in the chat.
  await answer.getByRole('button', { name: 'Expand lit-1.glb' }).click();
  const preview = page.getByLabel('Model preview');
  await expect(preview.getByLabel('3D model lit-1.glb')).toBeVisible();
  const expanded = preview.getByRole('combobox', { name: 'Lighting' });
  await expect(expanded).toHaveText('Flat');
  await expanded.click();
  await page.getByRole('option', { name: 'Realistic' }).click();
  await expect(expanded).toHaveText('Realistic');
  await page.getByRole('button', { name: 'Close model preview' }).click();
  await expect(pickers).toHaveText(['Realistic', 'Realistic']);
  await expect(answer.locator('.model-note.failed')).toHaveCount(0);
  // The choice belongs to this device and outlives the page.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Show me the models/ }).click();
  // The chat opens at its end, where the second model is.
  await expect(answer.getByLabel('3D model lit-1.glb')).toBeVisible();
  await expect(pickers).toHaveText(['Realistic', 'Realistic']);
  await expect(answer.locator('.model-note.failed')).toHaveCount(0);
});

test('flat light draws the painted colours, and the realistic sun shadows the floor @webkit', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async (data) => {
    const modulePath = '/src/lib/model-scene.ts';
    const { createModelScene } = await import(/* @vite-ignore */ modulePath);
    const canvas = document.createElement('canvas');
    canvas.id = 'lit';
    // Over white, the shadow the floor catches reads as grey.
    canvas.style.cssText =
      'position: fixed; left: 0; top: 0; width: 400px; height: 300px; z-index: 2147483647; background: #fff';
    document.body.append(canvas);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    (window as any).scene = await createModelScene(canvas, bytes.buffer, 'glb', {
      lighting: 'flat',
    });
  }, texturedGlbBase64());
  /**
   * What the canvas shows, two frames on: how many pixels are each of the texture's four colours,
   * and how many are grey.
   */
  async function drawn() {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const png = (await page.locator('#lit').screenshot()).toString('base64');
    return page.evaluate(
      async ({ png, texels }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const painted = texels.map(() => 0);
        let grey = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
          // Drawing a texel through the GPU and back may move a channel by one.
          const texel = texels.findIndex(
            ([tr, tg, tb]) =>
              Math.abs(r - tr) <= 2 && Math.abs(g - tg) <= 2 && Math.abs(b - tb) <= 2,
          );
          if (texel >= 0) painted[texel]++;
          if (Math.max(r, g, b) - Math.min(r, g, b) <= 3 && r >= 90 && r <= 235) grey++;
        }
        return { painted, grey };
      },
      { png, texels: texturedGlbTexels },
    );
  }
  const exact = (counts: { painted: number[] }) => counts.painted.reduce((a, b) => a + b, 0);
  const flat = await drawn();
  // The texels the triangle shows keep their colours exactly, and nothing casts a shadow.
  expect(flat.painted.filter((count) => count > 500).length).toBeGreaterThanOrEqual(2);
  expect(flat.grey).toBe(0);
  // Studio light shades them, so few if any pixels keep a painted colour.
  await page.evaluate(() => (window as any).scene.setLighting('studio'));
  await expect.poll(async () => exact(await drawn())).toBeLessThan(exact(flat) / 20);
  expect((await drawn()).grey).toBe(0);
  // The realistic sun, high to the left in front, casts the triangle's shadow on the floor behind
  // it, where the view from above sees it. Both sides of a surface cast it: three.js would cast
  // a one-sided triangle's shadow only from its back.
  await page.evaluate(() => {
    const scene = (window as any).scene;
    scene.orbit(0, 1);
    scene.setLighting('realistic');
  });
  await expect.poll(async () => (await drawn()).grey).toBeGreaterThan(500);
  // A scene out of view takes the light chosen meanwhile when it returns.
  await page.evaluate(() => {
    const scene = (window as any).scene;
    scene.reset();
    scene.setVisible(false);
    scene.setLighting('flat');
    scene.setVisible(true);
  });
  await expect.poll(async () => exact(await drawn())).toBeGreaterThan(exact(flat) * 0.9);
  expect((await drawn()).grey).toBe(0);
  await page.evaluate(() => (window as any).scene.dispose());
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

test('in the chat the wheel scrolls past a model, and a pinch zooms it', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (data) => {
    const modulePath = '/src/lib/model-scene.ts';
    const { createModelScene } = await import(/* @vite-ignore */ modulePath);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: fixed; left: 0; top: 0; width: 400px; height: 250px';
    document.body.append(canvas);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const scene = await createModelScene(canvas, bytes.buffer, 'glb');
    const distance = () => {
      const { position, target } = scene.view();
      return Math.hypot(...position.map((value: number, i: number) => value - target[i]));
    };
    const wheel = (ctrlKey: boolean) => {
      const event = new WheelEvent('wheel', {
        clientX: 200,
        clientY: 125,
        deltaY: -50,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const start = distance();
    const scrolled = wheel(false);
    const afterWheel = distance();
    const pinched = wheel(true);
    return { start, scrolled, afterWheel, pinched, afterPinch: distance() };
  }, still);
  expect(result.scrolled).toBe(false);
  expect(result.afterWheel).toBe(result.start);
  expect(result.pinched).toBe(true);
  expect(result.afterPinch).toBeCloseTo(result.start * Math.exp(-0.5), 6);
});
