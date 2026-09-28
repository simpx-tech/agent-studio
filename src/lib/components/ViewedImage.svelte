<script lang="ts">
  import { ImageOff, RotateCcw } from '@lucide/svelte';
  import { toolOutputImageUrl } from '$lib/tool-output';
  import { KeptImage } from '$lib/tool-output-images.svelte';
  import type { ViewedImage } from '$lib/file-viewer.svelte';
  import ZoomableImage from './ZoomableImage.svelte';

  let {
    image,
    swipe,
  }: {
    image: ViewedImage;
    /** Steps to the next or previous file when the reader swipes across the whole image. */
    swipe?: (by: -1 | 1) => void;
  } = $props();

  // The chat's thumbnail usually read it already, so the viewer shows it at once.
  const kept = new KeptImage(() => ({
    runId: image.runId,
    toolId: image.toolId,
    index: image.info.index,
    connectionId: image.connectionId,
  }));
</script>

{#if kept.image}
  <ZoomableImage
    src={toolOutputImageUrl(kept.image)}
    alt={image.alt}
    width={image.info.width}
    height={image.info.height}
    onswipe={swipe}
  />
{:else if kept.error}
  <div class="viewed-note failed" role="alert">
    <ImageOff size={16} aria-hidden="true" /><span>{kept.error}</span>
    <button type="button" class="viewed-retry" onclick={() => kept.retry()}
      ><RotateCcw size={12} aria-hidden="true" />Retry</button
    >
  </div>
{:else}
  <p class="viewed-note" role="status">Loading image…</p>
{/if}

<style>
  .viewed-note {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 16px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
  .viewed-note.failed {
    color: var(--danger);
  }
  .viewed-retry {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .viewed-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
