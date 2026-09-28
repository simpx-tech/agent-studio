<script lang="ts">
  import { ImageOff, RotateCcw } from '@lucide/svelte';
  import { imageLabel, toolOutputImageUrl, type ToolOutputImageInfo } from '$lib/tool-output';
  import { KeptImage } from '$lib/tool-output-images.svelte';

  let {
    runId,
    toolId,
    connectionId,
    info,
    name,
    open,
    tile = false,
  }: {
    runId: string;
    toolId: string;
    connectionId?: string;
    info: ToolOutputImageInfo;
    /** The tool that returned the image, for its description. */
    name: string;
    /** Opens the image full size, from the button that was clicked. */
    open: (from: HTMLElement) => void;
    /** A gallery tile: the image fills the positioned box its gallery shapes, uncaptioned. */
    tile?: boolean;
  } = $props();

  const kept = new KeptImage(() => ({ runId, toolId, index: info.index, connectionId }));
  const label = $derived(imageLabel(info));
  // Icons and other tiny images are enlarged with crisp pixels.
  const small = $derived((info.width ?? 64) < 64 && (info.height ?? 64) < 64);
</script>

<figure class="result-image" class:small class:tile>
  {#if kept.image}
    <button
      type="button"
      title={tile ? `${name} · ${label}` : 'Open image'}
      aria-label={`Open image ${info.index + 1}, ${label}`}
      onclick={(event) => open(event.currentTarget)}
    >
      <img
        src={toolOutputImageUrl(kept.image)}
        alt={`Image ${info.index + 1} returned by ${name}`}
        width={info.width}
        height={info.height}
      />
    </button>
  {:else if kept.error}
    <div class="image-state failed" role="alert">
      <ImageOff size={16} aria-hidden="true" /><span>{kept.error}</span>
      <button type="button" class="image-retry" onclick={() => kept.retry()}
        ><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </div>
  {:else}
    <!-- The placeholder takes the image's shape, so loading it moves nothing. -->
    <div
      class="image-state"
      role="status"
      style:aspect-ratio={!tile && info.width && info.height
        ? `${info.width} / ${info.height}`
        : undefined}
      style:width={!tile && info.width
        ? `min(100%, ${Math.max(info.width, small ? 64 : 0)}px)`
        : undefined}
    >
      Loading image…
    </div>
  {/if}
  {#if !tile}<figcaption>{label}</figcaption>{/if}
</figure>

<style>
  .result-image {
    display: grid;
    gap: 4px;
    max-width: 100%;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .result-image button:not(.image-retry) {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  .result-image:hover {
    border-color: var(--border-hover);
  }
  img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    width: auto;
    height: auto;
    border-radius: var(--radius-xs);
    background: repeating-conic-gradient(var(--hover) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  }
  .small img {
    min-width: 64px;
    image-rendering: pixelated;
  }
  /* A gallery tile fills the box its gallery gives it, which already has the image's shape. */
  .result-image.tile {
    position: absolute;
    inset: 0;
    display: block;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    overflow: hidden;
  }
  .tile button:not(.image-retry) {
    width: 100%;
    height: 100%;
    border-radius: inherit;
  }
  .tile button:not(.image-retry):hover,
  .tile button:not(.image-retry):focus-visible {
    outline: 1px solid var(--border-hover);
    outline-offset: -1px;
  }
  .tile img {
    width: 100%;
    height: 100%;
    max-height: none;
    min-width: 0;
    object-fit: contain;
  }
  .image-state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 120px;
    max-width: 100%;
    max-height: 320px;
    min-height: 48px;
    padding: 8px;
    border-radius: var(--radius-xs);
    background: var(--hover);
    font-size: var(--text-xs);
    text-align: center;
  }
  .tile .image-state {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    max-height: none;
    overflow: hidden;
  }
  .image-state.failed {
    color: var(--danger);
  }
  .image-retry {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .image-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
  figcaption {
    font-variant-numeric: tabular-nums;
  }
</style>
