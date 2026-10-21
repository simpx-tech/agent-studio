<script lang="ts">
  import { RotateCcw, Sheet } from '@lucide/svelte';
  import type { SentFile } from '$lib/sent-files';
  import { KeptTable } from '$lib/shown-files.svelte';
  import { whenNear } from '$lib/model-viewer';
  import type { FileViewer, ViewedPage } from '$lib/file-viewer.svelte';
  import FileCard from './FileCard.svelte';
  import TableGrid from './TableGrid.svelte';

  let {
    runId,
    toolId,
    connectionId,
    file,
    caption,
    viewer,
  }: {
    runId: string;
    toolId: string;
    connectionId?: string;
    file: SentFile;
    /** The caption of the group the table came in. */
    caption?: string;
    /** The viewer that connects this table with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  // The card and the viewer read one table, a page at a time.
  const table = new KeptTable(() => ({ runId, toolId, index: file.index, connectionId }));
  let preview = $state<HTMLElement>();
  // The first rows are read as the card nears the screen.
  $effect(() => {
    const element = preview;
    if (element) return whenNear(element, () => table.need(0, 0));
  });
  // The table reads in place wherever it is shown.
  const shown = () => {};
  const viewed = $derived<ViewedPage>({
    kind: 'table',
    name: file.name,
    label: table.detail(file),
    caption,
    view: expandedView,
    shown,
  });
</script>

{#snippet state()}
  {#if table.error}
    <p class="table-note failed" role="alert">
      {table.error}
      <button
        type="button"
        class="table-retry"
        onclick={(event) => {
          event.stopPropagation();
          table.retry();
        }}><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </p>
  {:else}
    <p class="table-note" role="status">Loading table…</p>
  {/if}
{/snippet}

<!-- The file viewer draws the whole table, every sheet of it, beside the chat's other files. -->
{#snippet expandedView()}
  <div class="table-page">
    {#if table.sheets.length > 1}
      <div class="sheet-tabs" role="tablist" aria-label="Sheets">
        {#each table.sheets as sheet, index (index)}
          <button
            type="button"
            role="tab"
            class="sheet-tab"
            aria-selected={table.sheet === index}
            onclick={() => table.select(index)}>{sheet.name}</button
          >
        {/each}
      </div>
    {/if}
    {#if table.shown}
      {#key table.sheet}<TableGrid {table} />{/key}
    {:else}
      {@render state()}
    {/if}
  </div>
{/snippet}

<FileCard
  name={file.name}
  detail={table.detail(file)}
  attach={viewer.attach(() => viewed)}
  expand={(from) => viewer.open(from)}
>
  {#snippet icon()}<Sheet size={13} aria-hidden="true" />{/snippet}
  <!-- A click on the first rows opens the whole table. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="table-preview"
    bind:this={preview}
    onclick={(event) => viewer.open(event.currentTarget)}
  >
    {#if table.shown}
      <TableGrid {table} preview />
    {:else}
      {@render state()}
    {/if}
  </div>
</FileCard>

<style>
  .table-preview {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 60px;
    border-radius: var(--radius-xs);
    overflow: hidden;
    cursor: zoom-in;
  }
  /* In the file viewer the table stands on a surface of its own over the scrim. */
  .table-page {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .sheet-tabs {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
    padding: 6px 8px 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface-overlay);
    overflow-x: auto;
  }
  .sheet-tab {
    flex-shrink: 0;
    max-width: 240px;
    height: 28px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .sheet-tab:hover {
    color: var(--text);
  }
  .sheet-tab[aria-selected='true'] {
    border-color: var(--border);
    background: var(--surface-1);
    color: var(--text);
  }
  .table-note {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 12px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
  .table-note.failed {
    color: var(--danger);
  }
  .table-retry {
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
  .table-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
