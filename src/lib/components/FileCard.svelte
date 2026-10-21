<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { Maximize2 } from '@lucide/svelte';

  let {
    name,
    detail,
    attach,
    expand,
    icon,
    children,
  }: {
    /** The file's name, as the reply gave it. */
    name: string;
    /** Its format and size, and what else the card knows of it. */
    detail: string;
    /** Registers the card with the chat's file viewer, which steps from file to file. */
    attach: Attachment<HTMLElement>;
    /** Opens the file in the viewer, from the control that was used. */
    expand: (from: HTMLElement) => void;
    icon: Snippet;
    /** The file's look in the chat. */
    children: Snippet;
  } = $props();
</script>

<!-- A table, a document or a video a reply shows, with its name and Expand below it. -->
<figure class="file-card" {@attach attach}>
  {@render children()}
  <div class="file-card-bar">
    <span class="file-card-name" title={name}>{@render icon()}<span>{name}</span></span>
    <span class="file-card-spacer"></span>
    <span class="file-card-detail">{detail}</span>
    <button
      type="button"
      class="file-card-action"
      aria-label={`Expand ${name}`}
      aria-haspopup="dialog"
      onclick={(event) => expand(event.currentTarget)}
    >
      <Maximize2 size={13} aria-hidden="true" />
    </button>
  </div>
</figure>

<style>
  .file-card {
    display: grid;
    gap: 4px;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .file-card:hover {
    border-color: var(--border-hover);
  }
  .file-card-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .file-card-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: min(320px, 60%);
  }
  .file-card-name > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-card-spacer {
    flex: 1;
  }
  .file-card-detail {
    font-variant-numeric: tabular-nums;
  }
  .file-card-action {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .file-card-action:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
