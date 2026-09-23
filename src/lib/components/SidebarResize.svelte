<script lang="ts">
  import { onMount } from 'svelte';

  let { onresize }: { onresize: (width: number) => void } = $props();
  const storageKey = 'agent-studio.sidebar-width';
  const minWidth = 180;
  let viewportWidth = $state(1380);
  let preferredWidth = $state<number>();
  let handle = $state<HTMLDivElement>();
  let drag = $state<{
    pointerId: number;
    x: number;
    width: number;
    previous?: number;
  }>();
  const maxWidth = $derived(Math.max(minWidth, Math.min(480, viewportWidth - 600)));
  const defaultWidth = $derived(viewportWidth <= 900 ? 190 : viewportWidth <= 1150 ? 210 : 236);
  const width = $derived(Math.max(minWidth, Math.min(maxWidth, preferredWidth ?? defaultWidth)));

  $effect(() => {
    onresize(width);
  });
  // A root class keeps the drag cursor rule cheap for every other style recalculation.
  $effect(() => {
    if (!drag) return;
    const root = document.documentElement;
    root.classList.add('sidebar-resizing');
    return () => root.classList.remove('sidebar-resizing');
  });

  onMount(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= minWidth && saved <= 480) preferredWidth = saved;
    } catch {
      // This optional layout preference can stay in memory when storage is unavailable.
    }
  });

  function save() {
    try {
      if (preferredWidth === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferredWidth));
    } catch {
      // Resizing still works for this session.
    }
  }
  function start(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle?.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width, previous: preferredWidth };
    handle?.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    preferredWidth = Math.round(
      Math.max(minWidth, Math.min(maxWidth, drag.width + event.clientX - drag.x)),
    );
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previousDrag = drag;
    drag = undefined;
    if (cancel) preferredWidth = previousDrag.previous;
    else save();
    if (handle?.hasPointerCapture(previousDrag.pointerId))
      handle.releasePointerCapture(previousDrag.pointerId);
  }
  function reset() {
    finish(true);
    preferredWidth = undefined;
    save();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finish(true);
      return;
    }
    if (drag) return;
    const step = event.shiftKey ? 50 : 10;
    if (event.key === 'ArrowLeft') preferredWidth = Math.max(minWidth, width - step);
    else if (event.key === 'ArrowRight') preferredWidth = Math.min(maxWidth, width + step);
    else if (event.key === 'Home') preferredWidth = minWidth;
    else if (event.key === 'End') preferredWidth = maxWidth;
    else if (event.key === 'Enter') reset();
    else return;
    event.preventDefault();
    save();
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} onblur={() => finish(true)} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (This focusable separator is a window splitter with range values and keyboard controls; aria-query classifies all separators as structural.) -->
<div
  bind:this={handle}
  class="sidebar-resizer"
  class:dragging={!!drag}
  role="separator"
  tabindex="0"
  aria-label="Resize sidebar"
  aria-controls="conversation-sidebar"
  aria-orientation="vertical"
  aria-valuemin={minWidth}
  aria-valuemax={maxWidth}
  aria-valuenow={width}
  aria-valuetext={`${width} pixels`}
  title="Drag to resize. Use arrow keys to adjust; double-click or press Enter to reset."
  onpointerdown={start}
  onpointermove={move}
  onpointerup={() => finish()}
  onpointercancel={() => finish(true)}
  onlostpointercapture={() => finish()}
  onkeydown={keydown}
  ondblclick={reset}
></div>

<style>
  .sidebar-resizer {
    position: absolute;
    inset: 0 -4px 0 auto;
    width: 8px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .sidebar-resizer::after {
    content: '';
    position: absolute;
    inset: 0 3px;
    background: transparent;
  }
  .sidebar-resizer:hover::after,
  .sidebar-resizer:focus-visible::after,
  .sidebar-resizer.dragging::after {
    transition: background-color var(--duration) ease;
    background: var(--accent-border);
  }
  :global(:root.sidebar-resizing),
  :global(:root.sidebar-resizing *) {
    cursor: col-resize !important;
    user-select: none !important;
  }
  @media (max-width: 650px) {
    .sidebar-resizer {
      display: none;
    }
  }
</style>
