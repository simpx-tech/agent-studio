/**
 * Where an opened image sits in its stage as the reader zooms and pans it. The image is drawn
 * `scale` times its natural size with its top-left corner at `x`, `y` in the stage, so a view
 * becomes one transform and nothing is laid out again.
 */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ZoomView = { scale: number; x: number; y: number };

/** Tiny images open enlarged to at least this many pixels on their shorter side. */
const SMALLEST = 64;
/** A scale this close to another is the same one, as the fitted view after a round trip. */
const SAME = 1.001;

/** The scale that shows the whole image, enlarging only a tiny one. */
export function fitScale(image: Size, stage: Size): number {
  if (!(image.width > 0 && image.height > 0 && stage.width > 0 && stage.height > 0)) return 1;
  const enlarged = Math.max(1, SMALLEST / Math.min(image.width, image.height));
  return Math.min(stage.width / image.width, stage.height / image.height, enlarged);
}

/** From the whole image, or its natural size for a tiny one, to well past its pixels. */
export function scaleLimits(image: Size, stage: Size) {
  const fit = fitScale(image, stage);
  return { min: Math.min(fit, 1), max: Math.max(8, fit * 4) };
}

/** Whether the reader zoomed in past the whole image, so dragging pans instead of swiping. */
export function isZoomed(view: ZoomView, image: Size, stage: Size): boolean {
  return view.scale > fitScale(image, stage) * SAME;
}

/** Keeps the scale within its limits and the image over the stage: centered on an axis it
 * does not fill, and otherwise covering that axis from edge to edge. */
export function clampView(view: ZoomView, image: Size, stage: Size): ZoomView {
  const { min, max } = scaleLimits(image, stage);
  const scale = Math.min(max, Math.max(min, view.scale));
  const axis = (offset: number, length: number, room: number) => {
    const drawn = length * scale;
    return drawn <= room ? (room - drawn) / 2 : Math.min(0, Math.max(room - drawn, offset));
  };
  return {
    scale,
    x: axis(view.x, image.width, stage.width),
    y: axis(view.y, image.height, stage.height),
  };
}

/** The whole image, centered. */
export function fitView(image: Size, stage: Size): ZoomView {
  return clampView({ scale: fitScale(image, stage), x: 0, y: 0 }, image, stage);
}

/** Scales by `factor`, keeping the point of the image under `at` where it is. */
export function zoomAt(
  view: ZoomView,
  factor: number,
  at: Point,
  image: Size,
  stage: Size,
): ZoomView {
  const { min, max } = scaleLimits(image, stage);
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const ratio = scale / view.scale;
  return clampView(
    { scale, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio },
    image,
    stage,
  );
}

export function zoomTo(view: ZoomView, scale: number, at: Point, image: Size, stage: Size) {
  return zoomAt(view, scale / view.scale, at, image, stage);
}

export function panBy(view: ZoomView, dx: number, dy: number, image: Size, stage: Size) {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, stage);
}

/** A double click or tap zooms in where it lands, and back out to the whole image. */
export function toggleZoom(view: ZoomView, at: Point, image: Size, stage: Size): ZoomView {
  if (isZoomed(view, image, stage)) return fitView(image, stage);
  const fit = fitScale(image, stage);
  return zoomTo(view, fit < 1 ? Math.max(1, fit * 2) : fit * 2, at, image, stage);
}

/**
 * How far one wheel event zooms: a mouse notch is a step, and a touchpad pinch, which the
 * browser reports as a wheel with Ctrl held, follows the fingers.
 */
export function wheelFactor(
  event: { deltaY: number; deltaMode: number; ctrlKey: boolean },
  page: number,
): number {
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1);
  return Math.exp(-pixels * (event.ctrlKey ? 0.01 : 0.002));
}
