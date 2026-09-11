<script lang="ts">
  import { onMount } from 'svelte';

  let {
    availableWidth,
    onresize,
  }: {
    availableWidth: number;
    onresize: (width: number) => void;
  } = $props();
  const storageKey = 'agent-studio.artifact-panel-width';
  const minWidth = 360;
  let preferredWidth = $state<number>();
  let handle = $state<HTMLDivElement>();
  let drag = $state<{
    pointerId: number;
    x: number;
    width: number;
    previous?: number;
  }>();
  const maxWidth = $derived(Math.max(minWidth, Math.floor(availableWidth - 420)));
  const defaultWidth = $derived(Math.min(620, Math.round(availableWidth * 0.42)));
  const width = $derived(Math.max(minWidth, Math.min(maxWidth, preferredWidth ?? defaultWidth)));

  $effect(() => onresize(width));

  onMount(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= minWidth) preferredWidth = saved;
    } catch {
      // Layout preferences remain optional when browser storage is unavailable.
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
      Math.max(minWidth, Math.min(maxWidth, drag.width + drag.x - event.clientX)),
    );
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    if (cancel) preferredWidth = previous.previous;
    else save();
    if (handle?.hasPointerCapture(previous.pointerId))
      handle.releasePointerCapture(previous.pointerId);
  }
  function reset() {
    finish(true);
    preferredWidth = undefined;
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
    if (event.key === 'ArrowLeft') preferredWidth = Math.min(maxWidth, width + step);
    else if (event.key === 'ArrowRight') preferredWidth = Math.max(minWidth, width - step);
    else if (event.key === 'Home') preferredWidth = minWidth;
    else if (event.key === 'End') preferredWidth = maxWidth;
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
  class="artifact-resizer"
  class:dragging={!!drag}
  role="separator"
  tabindex="0"
  aria-label="Resize artifact panel"
  aria-controls="artifact-viewer"
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
  .artifact-resizer {
    position: absolute;
    inset: 0 auto 0 0;
    width: 8px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .artifact-resizer::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: transparent;
  }
  .artifact-resizer:hover::after,
  .artifact-resizer:focus-visible::after,
  .artifact-resizer.dragging::after {
    background: var(--green);
  }
  :global(.app-shell:has(.artifact-resizer.dragging)),
  :global(.app-shell:has(.artifact-resizer.dragging) *) {
    cursor: col-resize !important;
    user-select: none !important;
  }
  :global(.app-shell:has(.artifact-resizer.dragging) iframe) {
    pointer-events: none;
  }
</style>
