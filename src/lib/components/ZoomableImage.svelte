<script lang="ts">
  import { untrack } from 'svelte';
  import { Shrink, ZoomIn, ZoomOut } from '@lucide/svelte';
  import {
    imageZoom,
    wheelFactor,
    type Point,
    type SharedView,
    type Size,
    type ZoomView,
  } from '$lib/image-zoom';

  let {
    src,
    alt,
    width,
    height,
    onswipe,
    pane,
    onmoved,
    initial,
  }: {
    src: string;
    alt: string;
    /** The image's reported size, until the browser reads it from the image itself. */
    width?: number;
    height?: number;
    /** A horizontal swipe across the whole image: 1 towards the next file, -1 the previous. */
    onswipe?: (by: -1 | 1) => void;
    /**
     * A pane of a comparison, in the chat or in the file viewer: the image fills it however
     * small, the comparison holds the controls, and keys act on the pane that has focus. In the
     * chat the wheel and vertical swipes scroll past it until it is zoomed in.
     */
    pane?: 'inline' | 'expanded';
    /** The reader moved the image, which shows what `view` shows on any image beside it. */
    onmoved?: (view: SharedView) => void;
    /** Asked once the pane is first drawn: what the images beside it show, which it shows too. */
    initial?: () => SharedView | undefined;
  } = $props();

  const zoom = $derived(imageZoom(!!pane));
  let stage = $state<HTMLDivElement>();
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let natural = $state<Size>();
  const image = $derived<Size>(natural ?? { width: width ?? 0, height: height ?? 0 });
  const room = $derived<Size>({ width: stageWidth, height: stageHeight });
  const ready = $derived(image.width > 0 && image.height > 0 && room.width > 0 && room.height > 0);
  let view = $state<ZoomView>({ scale: 1, x: 0, y: 0 });
  // Until the reader zooms, the image stays whole however the stage changes size.
  let fitted = $state(true);
  // A pane keeps what it shows as shares of the image, so a new size of its stage, or a view
  // another pane passed before this image was drawn, shows the same region.
  let shared: SharedView | undefined;
  const zoomed = $derived(ready && zoom.isZoomed(view, image, room));
  const limits = $derived(zoom.scaleLimits(image, room));
  // A swipe at the whole image follows the finger, and eases back when it falls short.
  let swipe = $state(0);
  let settling = $state(false);
  let grabbing = $state(false);

  function show(next: ZoomView) {
    view = next;
    fitted = Math.abs(next.scale / zoom.fitScale(image, room) - 1) < 1e-3;
  }
  /** The reader moved the image. */
  function apply(next: ZoomView) {
    show(next);
    if (!pane) return;
    shared = zoom.shareView(next, image, room);
    onmoved?.(shared);
  }
  const center = (): Point => ({ x: room.width / 2, y: room.height / 2 });
  let drawn = false;
  $effect(() => {
    if (!ready) return;
    const [shown, size] = [image, room];
    untrack(() => {
      // A pane that loads after the reader moved the others joins them.
      const joined = pane && !drawn ? initial?.() : undefined;
      drawn = true;
      if (joined) {
        shared = joined;
        fitted = Math.abs(joined.zoom - 1) < 1e-3;
      }
      if (pane && shared && !fitted) show(zoom.takeView(shared, shown, size));
      else view = fitted ? zoom.fitView(shown, size) : zoom.clampView(view, shown, size);
    });
  });

  /** Zooms around the stage's centre, as the comparison's zoom buttons do. */
  export function zoomBy(factor: number) {
    if (ready) apply(zoom.zoomAt(view, factor, center(), image, room));
  }
  /** Shows the whole image again. */
  export function fit() {
    if (ready) apply(zoom.fitView(image, room));
  }
  /** What the image shows, for another image to take; unknown until it is drawn. */
  export function current(): SharedView | undefined {
    return ready ? zoom.shareView(view, image, room) : undefined;
  }
  /** Shows what another image of a comparison shows, without reporting it. */
  export function take(next: SharedView) {
    shared = next;
    if (ready) show(zoom.takeView(next, image, room));
    else fitted = Math.abs(next.zoom - 1) < 1e-3;
  }

  type Gesture =
    | { kind: 'pan'; from: Point; start: ZoomView }
    | { kind: 'swipe'; from: Point }
    | { kind: 'pinch'; distance: number; middle: Point; start: ZoomView };
  const pointers = new Map<number, Point>();
  let gesture: Gesture | undefined;
  let origin = { left: 0, top: 0 };
  // How far the pointers moved since the first went down, which tells a tap from a drag.
  let travel = 0;
  let lastTap: { at: number; point: Point } | undefined;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const local = (event: MouseEvent): Point => ({
    x: event.clientX - origin.left,
    y: event.clientY - origin.top,
  });

  /** Starts what the pointers now down do: two pinch, one pans a zoomed image or swipes. */
  function begin() {
    const [a, b] = [...pointers.values()];
    swipe = 0;
    if (a && b)
      gesture = {
        kind: 'pinch',
        distance: Math.max(1, distance(a, b)),
        middle: middle(a, b),
        start: view,
      };
    else if (a)
      gesture =
        zoomed || !onswipe ? { kind: 'pan', from: a, start: view } : { kind: 'swipe', from: a };
    else gesture = undefined;
    grabbing = gesture?.kind === 'pan' && zoomed;
  }
  function down(event: PointerEvent) {
    if (!ready || !stage || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (!pointers.size) {
      const box = stage.getBoundingClientRect();
      origin = { left: box.left, top: box.top };
      travel = 0;
    }
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, local(event));
    settling = false;
    begin();
  }
  function move(event: PointerEvent) {
    const previous = pointers.get(event.pointerId);
    if (!previous || !gesture) return;
    const point = local(event);
    travel += distance(point, previous);
    pointers.set(event.pointerId, point);
    if (gesture.kind === 'pinch') {
      const [a, b] = [...pointers.values()];
      const now = middle(a, b);
      const scaled = zoom.zoomAt(
        gesture.start,
        distance(a, b) / gesture.distance,
        gesture.middle,
        image,
        room,
      );
      apply(zoom.panBy(scaled, now.x - gesture.middle.x, now.y - gesture.middle.y, image, room));
    } else if (gesture.kind === 'pan') {
      // A drag that moves nothing, as on an image seen whole, reports nothing either.
      const next = zoom.panBy(
        gesture.start,
        point.x - gesture.from.x,
        point.y - gesture.from.y,
        image,
        room,
      );
      if (next.x !== view.x || next.y !== view.y || next.scale !== view.scale) apply(next);
    } else swipe = point.x - gesture.from.x;
  }
  function up(event: PointerEvent) {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    pointers.delete(event.pointerId);
    const released = event.type === 'pointerup';
    const point = released ? local(event) : last;
    if (gesture?.kind === 'swipe' && !pointers.size) {
      const dx = point.x - gesture.from.x;
      const dy = point.y - gesture.from.y;
      // The image eases back unless the viewer steps away, which it cannot past either end.
      settling = swipe !== 0;
      if (released && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        gesture = undefined;
        swipe = 0;
        onswipe?.(dx < 0 ? 1 : -1);
        return;
      }
    }
    if (released && !pointers.size && travel < 8) tap(point);
    begin();
  }
  /** A second tap or click in the same place zooms in there, or back out to the whole image. */
  function tap(point: Point) {
    const now = performance.now();
    if (lastTap && now - lastTap.at < 350 && distance(point, lastTap.point) < 30) {
      lastTap = undefined;
      apply(zoom.toggleZoom(view, point, image, room));
    } else lastTap = { at: now, point };
  }

  // The wheel zooms where the pointer is; a sideways scroll pans a zoomed image. In the chat a
  // pane leaves the wheel to the conversation, zooming only with a touchpad pinch, which the
  // browser reports as a wheel with Ctrl held.
  $effect(() => {
    const element = stage;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!ready || (pane === 'inline' && !event.ctrlKey)) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      origin = { left: box.left, top: box.top };
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY))
        apply(zoom.panBy(view, -event.deltaX, 0, image, room));
      else apply(zoom.zoomAt(view, wheelFactor(event, room.height), local(event), image, room));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  // Keys zoom wherever focus is in the viewer, and the arrows pan an image zoomed in, before
  // the viewer would step to another file with them. A comparison's pane takes them only while
  // it has focus, so each of its images keeps its own.
  function keys(event: KeyboardEvent) {
    if (!ready || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.3 : 0.1;
    const pan = (dx: number, dy: number) =>
      zoomed
        ? zoom.panBy(view, dx * room.width * step, dy * room.height * step, image, room)
        : undefined;
    const actions: Record<string, () => ZoomView | undefined> = {
      '+': () => zoom.zoomAt(view, 1.25, center(), image, room),
      '=': () => zoom.zoomAt(view, 1.25, center(), image, room),
      '-': () => zoom.zoomAt(view, 0.8, center(), image, room),
      '0': () => zoom.fitView(image, room),
      '1': () => zoom.zoomTo(view, 1, center(), image, room),
      ArrowLeft: () => pan(1, 0),
      ArrowRight: () => pan(-1, 0),
      ArrowUp: () => pan(0, 1),
      ArrowDown: () => pan(0, -1),
    };
    const next = actions[event.key]?.();
    if (!next) return;
    event.preventDefault();
    apply(next);
  }
  $effect(() => {
    if (pane) return;
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  });
</script>

<!-- Pointers, the wheel and keys zoom and pan the image; the buttons below do the same. -->
{#if pane}
  <!-- The pane is the image, which takes focus for its zoom and pan keys like a 3D model's. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="zoom-stage pane"
    class:inline={pane === 'inline'}
    class:zoomed
    class:grabbing
    role="img"
    aria-label={alt}
    aria-keyshortcuts="+ - 0 1 ArrowLeft ArrowRight ArrowUp ArrowDown"
    tabindex="0"
    bind:this={stage}
    bind:clientWidth={stageWidth}
    bind:clientHeight={stageHeight}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={keys}
  >
    {@render picture()}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="zoom-stage"
    class:zoomed
    class:grabbing
    bind:this={stage}
    bind:clientWidth={stageWidth}
    bind:clientHeight={stageHeight}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
  >
    {@render picture()}
  </div>
  <div class="zoom-bar">
    <button
      type="button"
      class="zoom-action"
      aria-label="Zoom out"
      disabled={!ready || view.scale <= limits.min * 1.001}
      onclick={() => apply(zoom.zoomAt(view, 0.8, center(), image, room))}
      ><ZoomOut size={13} aria-hidden="true" /></button
    >
    <span class="zoom-level" title="Zoom, as a share of the image's own pixels"
      >{Math.round(view.scale * 100)}%</span
    >
    <button
      type="button"
      class="zoom-action"
      aria-label="Zoom in"
      disabled={!ready || view.scale >= limits.max / 1.001}
      onclick={() => apply(zoom.zoomAt(view, 1.25, center(), image, room))}
      ><ZoomIn size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="zoom-action"
      aria-label="Fit to window"
      title="Fit to window"
      disabled={!ready || fitted}
      onclick={() => apply(zoom.fitView(image, room))}
      ><Shrink size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="zoom-action"
      aria-label="Actual size"
      title="Actual size"
      disabled={!ready || Math.abs(view.scale - 1) < 1e-3}
      onclick={() => apply(zoom.zoomTo(view, 1, center(), image, room))}>1:1</button
    >
  </div>
{/if}

{#snippet picture()}
  <!-- A pane is the image itself to assistive technology, named for it. -->
  <img
    {src}
    alt={pane ? '' : alt}
    draggable="false"
    class:pixelated={view.scale >= 2}
    class:settling
    style:width={`${image.width}px`}
    style:height={`${image.height}px`}
    style:transform={`translate(${view.x + swipe}px, ${view.y}px) scale(${view.scale})`}
    style:visibility={ready ? undefined : 'hidden'}
    onload={(event) => {
      const { naturalWidth, naturalHeight } = event.currentTarget as HTMLImageElement;
      if (naturalWidth && naturalHeight) natural = { width: naturalWidth, height: naturalHeight };
    }}
    ontransitionend={() => (settling = false)}
  />
{/snippet}

<style>
  .zoom-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    cursor: zoom-in;
  }
  /* In the chat, vertical swipes over a pane seen whole scroll the conversation; once it is
     zoomed in, every drag pans it. */
  .zoom-stage.pane.inline:not(.zoomed) {
    touch-action: pan-y;
  }
  .zoom-stage.pane:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .zoom-stage.zoomed {
    cursor: grab;
  }
  .zoom-stage.grabbing {
    cursor: grabbing;
  }
  /* Laid out at its own size and placed by one transform, so zooming lays nothing out. */
  img {
    position: absolute;
    top: 0;
    left: 0;
    max-width: none;
    transform-origin: 0 0;
    pointer-events: none;
    background: repeating-conic-gradient(var(--hover) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px;
  }
  img.pixelated {
    image-rendering: pixelated;
  }
  img.settling {
    transition: transform var(--duration-fast) ease;
  }
  .zoom-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .zoom-level {
    min-width: 4em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .zoom-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 24px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .zoom-action:not(:disabled):hover {
    background: var(--hover);
    color: var(--text);
  }
  .zoom-action:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
