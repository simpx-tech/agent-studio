<script lang="ts">
  import type { KeptTable } from '$lib/shown-files.svelte';
  import { columnWidths, columnWindow, numeric, rowWindow } from '$lib/tables';

  let {
    table,
    preview = false,
  }: {
    table: KeptTable;
    /** The card's look at the first rows in the chat, rather than the whole sheet. */
    preview?: boolean;
  } = $props();

  /** The rows a card in the chat shows below the first one. */
  const PREVIEW_ROWS = 8;
  const row = $derived(preview ? 26 : 28);

  let scroller = $state<HTMLDivElement>();
  let top = $state(0);
  let left = $state(0);
  let width = $state(0);
  let height = $state(0);

  const shown = $derived(table.shown);
  const rows = $derived(shown?.rows ?? 0);
  const columns = $derived(shown?.columns ?? 0);
  // The sheet's first row stays above the others as its header.
  const body = $derived(Math.max(0, preview ? Math.min(rows - 1, PREVIEW_ROWS) : rows - 1));
  // Columns take the width the first rows need, measured once they come.
  const sample = $derived.by(() => {
    const read: string[][] = [];
    for (let index = 0; index < Math.min(rows, 64); index++) {
      const cells = table.row(index);
      if (cells) read.push(cells);
    }
    return read;
  });
  const widths = $derived(columnWidths(sample, columns, table.lengths[table.sheet]));
  const offsets = $derived.by(() => {
    const all = [0];
    for (const width of widths) all.push(all[all.length - 1] + width);
    return all;
  });
  const firstRow = $derived(shown?.firstRow ?? 1);
  const gutter = $derived(Math.max(36, String(firstRow + rows).length * 7.5 + 18));
  const wide = $derived(gutter + (offsets[columns] ?? 0));
  // The rows and columns in view, from the scroll as it stands.
  const view = $derived(
    preview
      ? { first: 0, last: body - 1, top: 0, height: body * row }
      : rowWindow({ scrollTop: top, viewport: height - row, row, rows: body }),
  );
  const visibleRows = $derived(
    Array.from(
      { length: Math.max(0, view.last - view.first + 1) },
      (_, index) => view.first + index,
    ),
  );
  const visibleColumns = $derived(
    columnWindow({ scrollLeft: left, viewport: width, gutter, offsets }),
  );
  const skip = $derived(visibleColumns.length ? offsets[visibleColumns[0]] : 0);
  // The pages holding the rows in view are asked for, each once.
  $effect(() => {
    if (shown) table.need(view.first + 1, view.last + 1);
    else table.need(0, 0);
  });
  function scrolled() {
    if (!scroller) return;
    top = scroller.scrollTop;
    left = scroller.scrollLeft;
  }
  const label = (cell: string | undefined) => (cell && cell.length > 12 ? cell : undefined);
</script>

{#snippet cells(values: string[] | undefined, head = false)}
  <span class="skip" style:width={`${skip}px`}></span>
  {#each visibleColumns as column (column)}
    {@const cell = values?.[column] ?? ''}
    <span
      class="cell"
      role={head ? 'columnheader' : 'cell'}
      class:number={!head && numeric(cell)}
      style:width={`${widths[column]}px`}
      title={label(cell)}>{cell}</span
    >
  {/each}
{/snippet}

<!-- Rows and columns out of view are not drawn: a sheet of any size scrolls at once. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="table-grid"
  class:preview
  bind:this={scroller}
  bind:clientWidth={width}
  bind:clientHeight={height}
  onscroll={scrolled}
  role="table"
  aria-label={shown?.name}
  aria-rowcount={rows}
  aria-colcount={columns}
  style:--row={`${row}px`}
  style:--gutter={`${gutter}px`}
  data-own-keys
  tabindex={preview ? -1 : 0}
>
  <div class="table-canvas" style:width={`${wide}px`} style:height={`${row + view.height}px`}>
    {#if shown}
      <div class="table-row head" role="row" style:width={`${wide}px`}>
        <span class="gutter" role="rowheader">{firstRow}</span>
        {@render cells(table.row(0), true)}
      </div>
      {#each visibleRows as index (index)}
        <div
          class="table-row"
          role="row"
          aria-rowindex={index + 2}
          style:width={`${wide}px`}
          style:top={`${row + view.top + (index - view.first) * row}px`}
        >
          <span class="gutter" role="rowheader">{firstRow + index + 1}</span>
          {@render cells(table.row(index + 1))}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .table-grid {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--surface-1);
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  .table-grid:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .table-grid.preview {
    flex: none;
    overflow-y: hidden;
    font-size: var(--text-xs);
  }
  .table-canvas {
    position: relative;
    min-width: 100%;
  }
  .table-row {
    position: absolute;
    left: 0;
    display: flex;
    height: var(--row);
  }
  /* The first row stays above the others as the sheet's header. */
  .table-row.head {
    position: sticky;
    top: 0;
    left: auto;
    z-index: 2;
    background: var(--surface-2);
    font-weight: 600;
  }
  .cell,
  .gutter,
  .skip {
    flex-shrink: 0;
    height: var(--row);
  }
  .cell {
    padding: 0 8px;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    line-height: calc(var(--row) - 1px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  .cell.number {
    text-align: right;
  }
  /* Row numbers stay at the left as the sheet scrolls sideways. */
  .gutter {
    position: sticky;
    left: 0;
    z-index: 1;
    width: var(--gutter);
    padding: 0 8px;
    border-right: 1px solid var(--border-strong);
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: 400;
    line-height: calc(var(--row) - 1px);
    text-align: right;
  }
  .head .gutter {
    z-index: 3;
  }
</style>
