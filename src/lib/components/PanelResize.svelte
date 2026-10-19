<script lang="ts">
  import { onMount } from 'svelte';

  // The left divider of a docked right-side panel, which remembers its width on this device.
  let {
    availableWidth,
    share: defaultShare,
    onresize,
    storageKey,
    label,
    controls,
  }: {
    availableWidth: number;
    /**
     * Keeps a share of the space rather than a width, this one until the reader resizes it, so
     * the panel and what it sits beside grow and shrink together with the window.
     */
    share?: number;
    onresize: (width: number) => void;
    storageKey: string;
    label: string;
    /** The id of the panel it resizes. */
    controls: string;
  } = $props();
  const minWidth = 360;
  const proportional = $derived(defaultShare !== undefined);
  // The reader's width, or their share of the space when proportional.
  let preferred = $state<number>();
  let handle = $state<HTMLDivElement>();
  let drag = $state<{
    pointerId: number;
    x: number;
    width: number;
    previous?: number;
  }>();
  const maxWidth = $derived(Math.max(minWidth, Math.floor(availableWidth - 420)));
  const wanted = $derived(
    proportional
      ? Math.round((preferred ?? defaultShare!) * availableWidth)
      : (preferred ?? Math.min(620, Math.round(availableWidth * 0.42))),
  );
  const width = $derived(Math.max(minWidth, Math.min(maxWidth, wanted)));
  /** Keeps a width the reader chose, as a share of the space when proportional. */
  function choose(next: number) {
    const clamped = Math.round(Math.max(minWidth, Math.min(maxWidth, next)));
    preferred = proportional && availableWidth > 0 ? clamped / availableWidth : clamped;
  }

  $effect(() => onresize(width));
  // A root class keeps the drag cursor rule cheap for every other style recalculation.
  $effect(() => {
    if (!drag) return;
    const root = document.documentElement;
    root.classList.add('panel-resizing');
    return () => root.classList.remove('panel-resizing');
  });

  onMount(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (proportional ? saved > 0 && saved < 1 : Number.isFinite(saved) && saved >= minWidth)
        preferred = saved;
    } catch {
      // Layout preferences remain optional when browser storage is unavailable.
    }
  });
  function save() {
    try {
      if (preferred === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred));
    } catch {
      // Resizing still works for this session.
    }
  }
  function start(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle?.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width, previous: preferred };
    handle?.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    choose(drag.width + drag.x - event.clientX);
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    if (cancel) preferred = previous.previous;
    else save();
    if (handle?.hasPointerCapture(previous.pointerId))
      handle.releasePointerCapture(previous.pointerId);
  }
  function reset() {
    finish(true);
    preferred = undefined;
    save();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
      return;
    }
    if (drag) return;
    const step = event.shiftKey ? 50 : 10;
    if (event.key === 'ArrowLeft') choose(width + step);
    else if (event.key === 'ArrowRight') choose(width - step);
    else if (event.key === 'Home') choose(minWidth);
    else if (event.key === 'End') choose(maxWidth);
    else if (event.key === 'Enter') reset();
    else return;
    event.preventDefault();
    event.stopPropagation();
    save();
  }
</script>

<svelte:window onblur={() => finish(true)} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (This focusable separator is a window splitter with range values and keyboard controls.) -->
<div
  bind:this={handle}
  class="panel-resizer"
  class:dragging={!!drag}
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-controls={controls}
  aria-orientation="vertical"
  aria-valuemin={minWidth}
  aria-valuemax={maxWidth}
  aria-valuenow={width}
  aria-valuetext={`${width} pixels`}
  title="Drag to resize. Left arrow widens, right arrow narrows; double-click or press Enter to reset."
  onpointerdown={start}
  onpointermove={move}
  onpointerup={(event) => {
    if (drag?.pointerId === event.pointerId) finish();
  }}
  onpointercancel={() => finish(true)}
  onlostpointercapture={() => finish(true)}
  onkeydown={keydown}
  ondblclick={reset}
></div>

<style>
  .panel-resizer {
    position: absolute;
    inset: 0 auto 0 0;
    width: 8px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .panel-resizer::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: transparent;
  }
  .panel-resizer:hover::after,
  .panel-resizer:focus-visible::after,
  .panel-resizer.dragging::after {
    background: var(--accent-border);
  }
  :global(:root.panel-resizing),
  :global(:root.panel-resizing *) {
    cursor: col-resize !important;
    user-select: none !important;
  }
  :global(:root.panel-resizing iframe) {
    pointer-events: none;
  }
</style>
