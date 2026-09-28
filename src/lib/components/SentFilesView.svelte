<script lang="ts">
  import {
    fileRuns,
    galleryRows,
    imageAspect,
    imageInfo,
    type FileRun,
    type SentFiles,
    type ShownFile,
  } from '$lib/sent-files';
  import { imageLabel } from '$lib/tool-output';
  import { FileViewer as Viewer, fileViewer, type ViewedImage } from '$lib/file-viewer.svelte';
  import ToolResultImage from './ToolResultImage.svelte';
  import ModelView from './ModelView.svelte';
  import FileViewer from './FileViewer.svelte';

  let {
    groups,
    connectionId,
  }: {
    /**
     * Accepted calls shown together: one group, or single images sent one call at a time and
     * placed side by side. Their files stay on the computer that ran the reply.
     */
    groups: SentFiles[];
    connectionId?: string;
  } = $props();

  // The chat connects every reply's files in one viewer; elsewhere a group has its own.
  const shared = fileViewer();
  const viewer = shared ?? new Viewer();
  const runs = $derived(fileRuns(groups));
  // Single images from several calls keep each call's caption under its own tile.
  const joined = $derived(groups.length > 1);
  const tileCaptions = $derived(joined && groups.some((group) => group.caption));
  /** A gallery row never grows taller than a lone image may stand in the chat. */
  const rowHeight = 320;
  // Between tiles, and the gallery's padding and border around them, as its styles set.
  const gap = 4;
  const frame = 5;
  const itemKey = ({ group, file }: ShownFile) => `${group.id}:${file.index}`;
  const runKey = (run: FileRun) =>
    run.kind === 'model' ? `model:${itemKey(run.item)}` : `image:${itemKey(run.items[0])}`;

  function viewed({ group, file }: ShownFile): ViewedImage {
    const info = imageInfo(file);
    return {
      kind: 'image',
      runId: group.runId,
      toolId: group.toolId,
      connectionId,
      info,
      name: file.name,
      label: imageLabel(info),
      caption: group.caption,
      alt: `Full size ${file.name}`,
    };
  }
  /** Consecutive images as rows of equal height that fill the gallery's width. */
  function gallery(items: ShownFile[]) {
    const aspects = items.map(({ file }) => imageAspect(file));
    const rows = galleryRows(aspects).map((row) => ({
      items: row.map((index) => ({ ...items[index], aspect: aspects[index] })),
      // Its width at the tallest row height, gaps included.
      widest: row.reduce((sum, index) => sum + aspects[index] * rowHeight, (row.length - 1) * gap),
    }));
    // A gallery whose rows all stop at that height is only as wide as its widest row.
    return { rows, widest: Math.max(...rows.map((row) => row.widest)) + 2 * frame };
  }
</script>

<figure class="sent-files">
  {#each runs as run (runKey(run))}
    {#if run.kind === 'model'}
      <ModelView
        runId={run.item.group.runId}
        toolId={run.item.group.toolId}
        {connectionId}
        file={run.item.file}
        caption={run.item.group.caption}
        {viewer}
      />
    {:else if run.items.length === 1}
      {@const item = run.items[0]}
      <div class="sent-image" {@attach viewer.attach(viewed(item))}>
        <ToolResultImage
          runId={item.group.runId}
          toolId={item.group.toolId}
          {connectionId}
          info={imageInfo(item.file)}
          name={item.file.name}
          open={(from) => viewer.open(from)}
        />
      </div>
    {:else}
      {@const layout = gallery(run.items)}
      <div
        class="sent-gallery"
        role="group"
        aria-label={`${run.items.length} images`}
        style:max-width={`${layout.widest}px`}
      >
        {#each layout.rows as row, index (index)}
          <div class="gallery-row" style:max-width={`${row.widest}px`}>
            {#each row.items as item (itemKey(item))}
              <div
                class="gallery-tile"
                style:flex-grow={item.aspect}
                {@attach viewer.attach(viewed(item))}
              >
                <div class="gallery-image" style:aspect-ratio={item.aspect}>
                  <ToolResultImage
                    runId={item.group.runId}
                    toolId={item.group.toolId}
                    {connectionId}
                    info={imageInfo(item.file)}
                    name={item.file.name}
                    open={(from) => viewer.open(from)}
                    tile
                  />
                </div>
                {#if tileCaptions}<span class="gallery-caption" title={item.group.caption}
                    >{item.group.caption ?? ''}</span
                  >{/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  {/each}
  {#if !joined && groups[0]?.caption}<figcaption>{groups[0].caption}</figcaption>{/if}
</figure>
{#if !shared}<FileViewer {viewer} />{/if}

<style>
  .sent-files {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin: 0 0 14px;
  }
  .sent-image {
    display: flex;
    min-width: 0;
  }
  /* Rows of equal height: each tile's width follows its image's shape, so none is cropped. */
  .sent-gallery {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
  }
  .sent-gallery:hover {
    border-color: var(--border-hover);
  }
  .gallery-row {
    display: flex;
    gap: 4px;
    min-width: 0;
  }
  .gallery-tile {
    display: flex;
    flex-direction: column;
    flex-shrink: 1;
    flex-basis: 0;
    gap: 2px;
    min-width: 0;
  }
  .gallery-image {
    position: relative;
    border-radius: var(--radius-xs);
    background: var(--hover);
    overflow: hidden;
  }
  /* One line under each tile, so the tiles of a row keep one height. */
  .gallery-caption {
    min-height: 1.5em;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  figcaption {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
