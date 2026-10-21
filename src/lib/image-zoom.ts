/**
 * Where an opened image sits in its stage as the reader zooms and pans it. The image is drawn
 * `scale` times its natural size with its top-left corner at `x`, `y` in the stage, so a view
 * becomes one transform and nothing is laid out again.
 */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ZoomView = { scale: number; x: number; y: number };
/**
 * Room the stage keeps clear around the whole image, such as the file viewer's controls floating
 * over its edges: the image fits and centres within the rest, and once zoomed in pans under them.
 */
export type Inset = { top: number; right: number; bottom: number; left: number };
/** A stage, with the room its edges keep clear, if any. */
export type Stage = Size & Partial<Inset>;
/**
 * A view as another image takes it, whatever its size or its stage's: how many times the whole
 * image it is zoomed, and the point of the image at the stage's centre, as shares of the image's
 * width and height. Two pictures of one scene at different resolutions show the same region.
 */
export type SharedView = { zoom: number; x: number; y: number };

/** Tiny images open enlarged to at least this many pixels on their shorter side. */
const SMALLEST = 64;
/** A scale this close to another is the same one, as the fitted view after a round trip. */
const SAME = 1.001;
/**
 * How far past the whole image the reader may zoom: far enough that one pixel of the largest
 * photograph covers more than a stage, so in practice any detail. The limit is a share of the
 * whole image, so the images of a comparison, whatever their sizes, zoom exactly together.
 */
export const DEEPEST = 1024;
/**
 * How far past the whole image the reader zooms before any point of the image can be brought to
 * the stage's centre. Up to there the image is let go gradually, so zooming in or out never makes
 * it jump: whole, it stays centred, and it covers the stage as before until zoomed in a little.
 */
const LOOSE_AFTER = 0.5;

/** The room within the stage's clear edges, where the whole image stands. */
function frame(stage: Stage) {
  const top = stage.top ?? 0;
  const left = stage.left ?? 0;
  const width = Math.max(0, stage.width - left - (stage.right ?? 0));
  const height = Math.max(0, stage.height - top - (stage.bottom ?? 0));
  return { width, height, x: left + width / 2, y: top + height / 2 };
}

/**
 * How images zoom and pan. An image shown alone opens at its own size when it fits, enlarging
 * only a tiny one; with `fill`, as in a comparison's panes, every image fills its stage however
 * small, so images of one scene at different resolutions show at one size and zoom together.
 */
export function imageZoom(fill = false) {
  /** The scale that shows the whole image. */
  function fitScale(image: Size, stage: Stage): number {
    const room = frame(stage);
    if (!(image.width > 0 && image.height > 0 && room.width > 0 && room.height > 0)) return 1;
    const enlarged = fill ? Infinity : Math.max(1, SMALLEST / Math.min(image.width, image.height));
    return Math.min(room.width / image.width, room.height / image.height, enlarged);
  }

  /** From the whole image, or its natural size for a tiny one, to deeper than any pixel. */
  function scaleLimits(image: Size, stage: Stage) {
    const fit = fitScale(image, stage);
    return { min: Math.min(fit, 1), max: fit * DEEPEST };
  }

  /** Whether the reader zoomed in past the whole image, so dragging pans instead of swiping. */
  function isZoomed(view: ZoomView, image: Size, stage: Stage): boolean {
    return view.scale > fitScale(image, stage) * SAME;
  }

  /**
   * Keeps the scale within its limits and the image where the reader can see it. Whole or
   * smaller, it stays centred. Zoomed in, the point at the centre of the room can be any point
   * of the image, so its edges and corners can be looked at as closely as its middle; just past
   * the whole image, it covers the room from edge to edge on each axis it fills, and gives way
   * gradually as the reader zooms in.
   */
  function clampView(view: ZoomView, image: Size, stage: Stage): ZoomView {
    const { min, max } = scaleLimits(image, stage);
    const scale = Math.min(max, Math.max(min, view.scale));
    const fit = fitScale(image, stage);
    const loose = Math.min(1, Math.max(0, (scale / fit - 1) / LOOSE_AFTER));
    const room = frame(stage);
    const axis = (offset: number, length: number, extent: number, middle: number) => {
      const drawn = length * scale;
      // The share of the image at the room's centre ranges over [low, 1 - low].
      const low = ((1 - loose) * extent) / (2 * drawn);
      if (!(drawn > 0) || low >= 0.5) return middle - drawn / 2;
      const share = (middle - offset) / drawn;
      // A view within bounds keeps its offset exactly, so nothing drifts as it is clamped again.
      if (share >= low && share <= 1 - low) return offset;
      return middle - Math.min(1 - low, Math.max(low, share)) * drawn;
    };
    return {
      scale,
      x: axis(view.x, image.width, room.width, room.x),
      y: axis(view.y, image.height, room.height, room.y),
    };
  }

  /** The whole image, centered. */
  function fitView(image: Size, stage: Stage): ZoomView {
    return clampView({ scale: fitScale(image, stage), x: 0, y: 0 }, image, stage);
  }

  /** Scales by `factor`, keeping the point of the image under `at` where it is. */
  function zoomAt(view: ZoomView, factor: number, at: Point, image: Size, stage: Stage): ZoomView {
    const { min, max } = scaleLimits(image, stage);
    const scale = Math.min(max, Math.max(min, view.scale * factor));
    const ratio = scale / view.scale;
    return clampView(
      { scale, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio },
      image,
      stage,
    );
  }

  function zoomTo(view: ZoomView, scale: number, at: Point, image: Size, stage: Stage) {
    return zoomAt(view, scale / view.scale, at, image, stage);
  }

  function panBy(view: ZoomView, dx: number, dy: number, image: Size, stage: Stage) {
    return clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, stage);
  }

  /** A double click or tap zooms in where it lands, and back out to the whole image. */
  function toggleZoom(view: ZoomView, at: Point, image: Size, stage: Stage): ZoomView {
    if (isZoomed(view, image, stage)) return fitView(image, stage);
    const fit = fitScale(image, stage);
    return zoomTo(view, fit < 1 ? Math.max(1, fit * 2) : fit * 2, at, image, stage);
  }

  /** The view as another image takes it. */
  function shareView(view: ZoomView, image: Size, stage: Stage): SharedView {
    const room = frame(stage);
    return {
      zoom: view.scale / fitScale(image, stage),
      x: (room.x - view.x) / view.scale / (image.width || 1),
      y: (room.y - view.y) / view.scale / (image.height || 1),
    };
  }

  /** The view of this image that shows what `shared` shows, within this image's limits. */
  function takeView(shared: SharedView, image: Size, stage: Stage): ZoomView {
    const room = frame(stage);
    const scale = shared.zoom * fitScale(image, stage);
    return clampView(
      {
        scale,
        x: room.x - shared.x * image.width * scale,
        y: room.y - shared.y * image.height * scale,
      },
      image,
      stage,
    );
  }

  /** Whether a point of the stage falls on the image as `view` draws it. */
  function onImage(view: ZoomView, at: Point, image: Size): boolean {
    return (
      at.x >= view.x &&
      at.y >= view.y &&
      at.x <= view.x + image.width * view.scale &&
      at.y <= view.y + image.height * view.scale
    );
  }

  return {
    fitScale,
    scaleLimits,
    isZoomed,
    clampView,
    fitView,
    zoomAt,
    zoomTo,
    panBy,
    toggleZoom,
    shareView,
    takeView,
    onImage,
  };
}

export const {
  fitScale,
  scaleLimits,
  isZoomed,
  clampView,
  fitView,
  zoomAt,
  zoomTo,
  panBy,
  toggleZoom,
  shareView,
  takeView,
  onImage,
} = imageZoom();

/** A zoom as the viewer shows it: a share of the image's own pixels, or past ten, a multiple. */
export const zoomLabel = (scale: number) =>
  scale >= 10 ? `${Math.round(scale).toLocaleString('en-US')}×` : `${Math.round(scale * 100)}%`;

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
