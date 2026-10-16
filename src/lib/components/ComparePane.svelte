<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PanePlace } from '$lib/comparison';

  let {
    place,
    label,
    detail,
    title,
    stage,
    extra,
  }: {
    place: PanePlace;
    /** The file's label in the comparison, or its name. */
    label: string;
    /** Its dimensions or format, and its size. */
    detail: string;
    /** The file's name and details, on hover. */
    title: string;
    /** The image or model, drawn to fill the pane. */
    stage: Snippet;
    /** Controls of the file's own, such as its animation. */
    extra?: Snippet;
  } = $props();
</script>

<div class="compare-pane" class:expanded={place === 'expanded'}>
  <div class="pane-stage">{@render stage()}</div>
  <div class="pane-caption" {title}>
    <span class="pane-label">{label}</span>
    <span class="pane-detail">{detail}</span>
    {@render extra?.()}
  </div>
</div>

<style>
  .compare-pane {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* Every pane of a comparison takes one shape, which the comparison sets. */
  .pane-stage {
    position: relative;
    display: flex;
    flex-direction: column;
    aspect-ratio: var(--pane-aspect, 1);
    max-height: min(520px, 65vh);
    min-height: 0;
    border-radius: var(--radius-xs);
    background: var(--code-bg);
    overflow: hidden;
  }
  /* In the file viewer the panes share the room the viewer's controls leave. */
  .compare-pane.expanded {
    min-height: 0;
    padding-bottom: 4px;
    background: var(--surface-overlay);
  }
  .compare-pane.expanded .pane-stage {
    flex: 1;
    aspect-ratio: auto;
    max-height: none;
    border-radius: 0;
  }
  .pane-caption {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 22px;
    padding: 0 2px;
  }
  .compare-pane.expanded .pane-caption {
    padding: 0 10px;
  }
  .pane-label {
    min-width: 0;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The details give way first when the pane is narrow. */
  .pane-detail {
    flex-shrink: 100;
    min-width: 0;
    overflow: hidden;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-caption :global(.picker-trigger) {
    min-height: 22px;
    margin-left: auto;
    padding: 0 4px 0 6px;
    gap: 4px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
