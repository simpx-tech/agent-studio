import { expect, it } from 'vitest';
import {
  clampView,
  fitScale,
  fitView,
  isZoomed,
  panBy,
  scaleLimits,
  toggleZoom,
  wheelFactor,
  zoomAt,
  zoomTo,
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
  // Never smaller than the whole image, never past eight times its pixels.
  expect(zoomAt(view, 0.1, at, screenshot, stage)).toEqual(view);
  expect(zoomAt(view, 1000, at, screenshot, stage).scale).toBe(8);
  expect(zoomTo(view, 1, at, screenshot, stage).scale).toBeCloseTo(1);
});

it('pans only as far as the image reaches, and centers an axis it does not fill', () => {
  const zoomed = clampView({ scale: 1, x: 0, y: 0 }, screenshot, stage);
  const left = panBy(zoomed, 10_000, 10_000, screenshot, stage);
  expect(left).toMatchObject({ x: 0, y: 0 });
  const right = panBy(zoomed, -10_000, -10_000, screenshot, stage);
  expect(right).toMatchObject({ x: 1000 - 1920, y: 600 - 1080 });
  // At the fitted scale the width fills the stage and the height is centered.
  const fit = fitView(screenshot, stage);
  expect(panBy(fit, 50, 50, screenshot, stage)).toEqual(fit);
  // A resized stage keeps a zoomed image covering it.
  const smaller = clampView(right, screenshot, { width: 1400, height: 900 });
  expect(smaller.x).toBe(1400 - 1920);
  expect(smaller.y).toBe(900 - 1080);
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
