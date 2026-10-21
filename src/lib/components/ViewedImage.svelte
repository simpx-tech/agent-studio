<script lang="ts">
  import { ImageOff, RotateCcw } from '@lucide/svelte';
  import { toolOutputImageUrl } from '$lib/tool-output';
  import { KeptImage } from '$lib/tool-output-images.svelte';
  import type { ViewedImage } from '$lib/file-viewer.svelte';
  import type { Inset } from '$lib/image-zoom';
  import ZoomableImage from './ZoomableImage.svelte';

  let {
    image,
    inset,
    swipe,
    backdrop,
  }: {
    image: ViewedImage;
    /** The room the viewer's controls keep clear of the whole image. */
    inset?: Inset;
    /** Steps to the next or previous file when the reader swipes across the whole image. */
    swipe?: (by: -1 | 1) => void;
    /** Closes the viewer, for a click beside the image. */
    backdrop?: () => void;
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
    {inset}
    onswipe={swipe}
    onbackdrop={backdrop}
  />
{:else if kept.error}
  <div class="viewed-note failed" role="alert" data-scrim>
    <ImageOff size={16} aria-hidden="true" /><span>{kept.error}</span>
    <button type="button" class="viewed-retry" onclick={() => kept.retry()}
      ><RotateCcw size={12} aria-hidden="true" />Retry</button
    >
  </div>
{:else}
  <p class="viewed-note" role="status" data-scrim>Loading image…</p>
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
    color: var(--viewer-text-muted);
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
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--viewer-border);
    border-radius: var(--radius-full);
    background: var(--viewer-control);
    color: var(--viewer-text);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .viewed-retry:hover {
    background: var(--viewer-control-hover);
  }
</style>
