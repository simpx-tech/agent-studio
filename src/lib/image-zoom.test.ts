import { expect, it } from 'vitest';
import {
  DEEPEST,
  clampView,
  fitScale,
  fitView,
  isZoomed,
  panBy,
  shareView,
  imageZoom,
  onImage,
  scaleLimits,
  toggleZoom,
  wheelFactor,
  zoomAt,
  zoomTo,
  type Point,
  type Size,
  type ZoomView,
} from './image-zoom';

const stage = { width: 1000, height: 600 };
const screenshot = { width: 1920, height: 1080 };

it('opens an image whole and centered, enlarging only a tiny one', () => {
  expect(fitScale(screenshot, stage)).toBeCloseTo(1000 / 1920);
  const view = fitView(screenshot, stage);
  expect(view.x).toBeCloseTo(0);
  // 1080 × 0.52 = 562.5 of 600 pixels, with the rest shared above and below.
  expect(view.y).toBeCloseTo((600 - 1080 * (1000 / 1920)) / 2);
  // A picture smaller than the stage keeps its own size.
  expect(fitScale({ width: 400, height: 300 }, stage)).toBe(1);
  // An icon grows to 64 pixels, as the chat shows it, and can still go back to its own size.
  expect(fitScale({ width: 16, height: 16 }, stage)).toBe(4);
  expect(scaleLimits({ width: 16, height: 16 }, stage).min).toBe(1);
  // Nothing measured yet leaves the image as it is.
  expect(fitScale({ width: 0, height: 0 }, stage)).toBe(1);
});

it('zooms around the point under the pointer and stops at its limits', () => {
  const view = fitView(screenshot, stage);
  const at = { x: 250, y: 300 };
  const zoomed = zoomAt(view, 2, at, screenshot, stage);
  expect(zoomed.scale).toBeCloseTo(view.scale * 2);
  // The image point under the pointer stays under it.
  const before = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale };
  const after = { x: (at.x - zoomed.x) / zoomed.scale, y: (at.y - zoomed.y) / zoomed.scale };
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  expect(isZoomed(zoomed, screenshot, stage)).toBe(true);
  // Never smaller than the whole image; deeper than any of its pixels, a thousand times the
  // whole image, where one pixel of this screenshot covers more than half the stage.
  expect(zoomAt(view, 0.1, at, screenshot, stage)).toEqual(view);
  const deepest = zoomAt(view, 1e9, at, screenshot, stage);
  expect(deepest.scale).toBeCloseTo(view.scale * DEEPEST);
  expect(deepest.scale).toBeGreaterThan(stage.height / 2);
  // However deep, the point under the pointer stays under it.
  expect((at.x - deepest.x) / deepest.scale).toBeCloseTo(before.x);
  expect((at.y - deepest.y) / deepest.scale).toBeCloseTo(before.y);
  expect(zoomTo(view, 1, at, screenshot, stage).scale).toBeCloseTo(1);
});

it('pans a zoomed image until any of its points stands at the centre, and none past it', () => {
  // At its own pixels the screenshot is nearly twice the stage's width: zoomed in for good.
  const zoomed = clampView({ scale: 1, x: 0, y: 0 }, screenshot, stage);
  expect(zoomed).toMatchObject({ x: 0, y: 0 });
  // Its top left corner comes to the stage's centre, and goes no further.
  const corner = panBy(zoomed, 10_000, 10_000, screenshot, stage);
  expect(corner).toMatchObject({ x: 500, y: 300 });
  // And so does its bottom right corner.
  const far = panBy(zoomed, -10_000, -10_000, screenshot, stage);
  expect(far).toMatchObject({ x: 500 - 1920, y: 300 - 1080 });
  // At the fitted scale the width fills the stage and the height is centered.
  const fit = fitView(screenshot, stage);
  expect(panBy(fit, 50, 50, screenshot, stage)).toEqual(fit);
  // A resized stage keeps a view still within bounds as it is, and brings one past them back.
  expect(clampView(corner, screenshot, { width: 1400, height: 900 })).toMatchObject(corner);
  expect(clampView(corner, screenshot, { width: 600, height: 400 })).toMatchObject({
    x: 300,
    y: 200,
  });
});

it('lets a zoomed image go gradually, so zooming in or out never makes it jump', () => {
  const fit = fitView(screenshot, stage);
  // Just past the whole image, it still covers the width from edge to edge, nearly.
  const barely = { scale: fit.scale * 1.02, x: 400, y: 0 };
  const held = clampView(barely, screenshot, stage);
  expect(held.x).toBeLessThan(25);
  // Further in, it gives more way, then lets any point reach the centre.
  const further = clampView({ ...barely, scale: fit.scale * 1.25 }, screenshot, stage);
  expect(further.x).toBeGreaterThan(held.x + 50);
  expect(further.x).toBeLessThan(500);
  expect(clampView({ ...barely, scale: fit.scale * 1.5, x: 1e6 }, screenshot, stage).x).toBe(500);
  // Zooming out from a corner brings the image back to the centre step by step.
  let view = panBy(
    clampView({ scale: 1, x: 0, y: 0 }, screenshot, stage),
    1e6,
    1e6,
    screenshot,
    stage,
  );
  let previous = view.x;
  for (let step = 0; step < 40; step++) {
    view = zoomAt(view, 0.95, { x: 500, y: 300 }, screenshot, stage);
    expect(Math.abs(view.x - previous)).toBeLessThan(80);
    previous = view.x;
  }
  expect(view).toEqual(fit);
});

it('fits an image within the room its stage keeps clear, and pans it under that room', () => {
  const window = { width: 1200, height: 800, top: 50, right: 100, bottom: 100, left: 100 };
  // The whole image fits the 1000 × 650 room left between the controls, centred there.
  const fit = fitView(screenshot, window);
  expect(fit.scale).toBeCloseTo(1000 / 1920);
  expect(fit.x).toBeCloseTo(100);
  expect(fit.y).toBeCloseTo(50 + (650 - 1080 * (1000 / 1920)) / 2);
  const whole = shareView(fit, screenshot, window);
  expect(whole.x).toBeCloseTo(0.5, 9);
  expect(whole.y).toBeCloseTo(0.5, 9);
  // Zoomed in, it reaches the window's edges, under the controls.
  const zoomed = zoomAt(fit, 4, { x: 600, y: 375 }, screenshot, window);
  const left = zoomed.x;
  const right = zoomed.x + screenshot.width * zoomed.scale;
  expect(left).toBeLessThan(0);
  expect(right).toBeGreaterThan(1200);
  // Any point can stand at the room's centre, which is not the window's.
  expect(panBy(zoomed, 1e6, 1e6, screenshot, window)).toMatchObject({ x: 600, y: 375 });
});

it('tells a point on the image from the room around it', () => {
  const fit = fitView(screenshot, stage);
  expect(onImage(fit, { x: 500, y: 300 }, screenshot)).toBe(true);
  // The bands above and below the whole screenshot are not the image.
  expect(onImage(fit, { x: 500, y: 5 }, screenshot)).toBe(false);
  expect(onImage(fit, { x: 500, y: 595 }, screenshot)).toBe(false);
});

it('toggles between the whole image and a closer look where the reader double-clicks', () => {
  const fit = fitView(screenshot, stage);
  const closer = toggleZoom(fit, { x: 800, y: 100 }, screenshot, stage);
  expect(closer.scale).toBeCloseTo((1000 / 1920) * 2);
  expect(toggleZoom(closer, { x: 0, y: 0 }, screenshot, stage)).toEqual(fit);
  // A photograph far larger than the stage goes to its own pixels.
  const photo = { width: 6000, height: 4000 };
  expect(toggleZoom(fitView(photo, stage), { x: 0, y: 0 }, photo, stage).scale).toBeCloseTo(1);
});

it('zooms a notch at a time from a wheel and follows a touchpad pinch', () => {
  const notch = wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 600);
  expect(notch).toBeLessThan(1);
  expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 600)).toBeCloseTo(1 / notch);
  // Lines are counted as pixels, and a pinch reports much smaller steps.
  expect(wheelFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false }, 600)).toBeCloseTo(
    wheelFactor({ deltaY: 48, deltaMode: 0, ctrlKey: false }, 600),
  );
  expect(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true }, 600)).toBeCloseTo(Math.exp(0.1));
});

it('fills a comparison pane with every image, and shares a view whatever its size', () => {
  const panes = imageZoom(true);
  // Alone, a small image keeps its own size; in a pane it fills the stage like a large one.
  const texture = { width: 256, height: 256 };
  const pane = { width: 400, height: 400 };
  expect(fitScale(texture, pane)).toBe(1);
  expect(panes.fitScale(texture, pane)).toBeCloseTo(400 / 256, 9);
  expect(panes.isZoomed(panes.fitView(texture, pane), texture, pane)).toBe(false);
  expect(panes.fitScale(screenshot, stage)).toBe(fitScale(screenshot, stage));
  // The whole image, seen from its centre.
  const fit = panes.fitView(screenshot, stage);
  const whole = panes.shareView(fit, screenshot, stage);
  expect(whole.zoom).toBeCloseTo(1, 9);
  expect(whole.x).toBeCloseTo(0.5, 9);
  expect(whole.y).toBeCloseTo(0.5, 9);
  // Zoomed in on the upper left, the half-size render beside it shows the same region.
  const closer = panes.zoomAt(fit, 3, { x: 200, y: 150 }, screenshot, stage);
  const shared = panes.shareView(closer, screenshot, stage);
  const half = { width: 960, height: 540 };
  const taken = panes.takeView(shared, half, stage);
  const seen = (view: ZoomView, image: Size, at: Point) => ({
    x: (at.x - view.x) / view.scale / image.width,
    y: (at.y - view.y) / view.scale / image.height,
  });
  for (const corner of [
    { x: 0, y: 0 },
    { x: stage.width, y: stage.height },
  ]) {
    expect(seen(taken, half, corner).x).toBeCloseTo(seen(closer, screenshot, corner).x, 9);
    expect(seen(taken, half, corner).y).toBeCloseTo(seen(closer, screenshot, corner).y, 9);
  }
  // Taken back by the image it came from, it is the same view.
  const back = panes.takeView(shared, screenshot, stage);
  expect(back.scale).toBeCloseTo(closer.scale, 9);
  expect(back.x).toBeCloseTo(closer.x, 9);
  expect(back.y).toBeCloseTo(closer.y, 9);
  // Each image stays within its own limits: whole at least, and as deep as any other pane, so
  // the panes of a comparison zoom together however far, whatever their images' sizes.
  expect(panes.takeView({ zoom: 0.01, x: 0, y: 0 }, screenshot, stage)).toEqual(fit);
  expect(panes.takeView({ zoom: 1e9, x: 0.5, y: 0.5 }, screenshot, stage).scale).toBeCloseTo(
    fit.scale * DEEPEST,
  );
  const deep = { zoom: 900, x: 0.97, y: 0.03 };
  expect(panes.shareView(panes.takeView(deep, half, stage), half, stage).zoom).toBeCloseTo(900, 6);
  expect(panes.shareView(panes.takeView(deep, texture, pane), texture, pane).x).toBeCloseTo(
    0.97,
    9,
  );
});
