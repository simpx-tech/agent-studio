<script lang="ts">
  import { FileText, RotateCcw } from '@lucide/svelte';
  import { formatBytes } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';
  import { KeptDocument, formatName } from '$lib/shown-files.svelte';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { whenNear } from '$lib/model-viewer';
  import type { FileViewer, ViewedPage } from '$lib/file-viewer.svelte';
  import FileCard from './FileCard.svelte';

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
    /** The caption of the group the document came in. */
    caption?: string;
    /** The viewer that connects this document with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  // The card shows the document's beginning; the viewer reads it whole.
  const kept = new KeptDocument(() => ({ runId, toolId, index: file.index, connectionId }));
  let preview = $state<HTMLElement>();
  $effect(() => {
    const element = preview;
    if (element) return whenNear(element, () => kept.read());
  });
  // Sanitized as a reply's own text is, so a document stays inert in the window.
  const beginning = $derived(kept.text ? renderMarkdown(kept.text.text) : '');
  const whole = $derived(kept.whole ? renderMarkdown(kept.whole.text) : '');
  const detail = $derived(`${formatName(file)} · ${formatBytes(file.bytes)}`);
  // The viewer reads the whole document once it shows it.
  const shown = (showing: boolean) => {
    if (showing) kept.read(true);
  };
  const viewed = $derived<ViewedPage>({
    kind: 'document',
    name: file.name,
    label: detail,
    caption,
    view: expandedView,
    shown,
  });
  // Links open in the browser, as a reply's do; the document's own anchors go nowhere.
  function links(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    void openLink(link.href).catch(() => {});
  }
</script>

{#snippet failed(whole: boolean)}
  <p class="document-note failed" role="alert">
    {kept.error}
    <button
      type="button"
      class="document-retry"
      onclick={(event) => {
        event.stopPropagation();
        kept.retry(whole);
      }}><RotateCcw size={12} aria-hidden="true" />Retry</button
    >
  </p>
{/snippet}

<!-- The file viewer draws the whole document, a page to read, beside the chat's other files. -->
{#snippet expandedView()}
  <div class="document-frame" data-scrim>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <article class="document-page" data-own-keys tabindex="0" aria-label={file.name}>
      {#if kept.whole}
        <!-- Sanitized as a reply's text is; links open in the browser through their handler. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="prose" onclick={links}>{@html whole}</div>
      {:else if kept.error}
        {@render failed(true)}
      {:else}
        <p class="document-note" role="status">Loading document…</p>
      {/if}
    </article>
  </div>
{/snippet}

<FileCard
  name={file.name}
  {detail}
  attach={viewer.attach(() => viewed)}
  expand={(from) => viewer.open(from)}
>
  {#snippet icon()}<FileText size={13} aria-hidden="true" />{/snippet}
  <!-- A click on the beginning opens the whole document. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="document-preview"
    bind:this={preview}
    onclick={(event) => viewer.open(event.currentTarget)}
  >
    {#if kept.text}
      <div class="prose" inert>{@html beginning}</div>
    {:else if kept.error}
      {@render failed(false)}
    {:else}
      <p class="document-note" role="status">Loading document…</p>
    {/if}
  </div>
</FileCard>

<style>
  /* The beginning, fading out where the card stops. */
  .document-preview {
    position: relative;
    max-height: 280px;
    min-height: 60px;
    padding: 12px 16px 0;
    border-radius: var(--radius-xs);
    background: var(--bg);
    overflow: hidden;
    cursor: zoom-in;
    mask-image: linear-gradient(to bottom, black calc(100% - 64px), transparent);
  }
  .document-preview .prose {
    pointer-events: none;
  }
  /* In the file viewer the document is a page to read, centred over the scrim. */
  .document-frame {
    display: flex;
    flex: 1;
    justify-content: center;
    min-height: 0;
  }
  .document-page {
    flex: 1;
    max-width: 880px;
    min-width: 0;
    padding: 36px 44px 48px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg);
    color: var(--text);
    box-shadow: var(--shadow-xl);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .document-page:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .document-note {
    display: flex;
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
  .document-note.failed {
    color: var(--danger);
  }
  .document-retry {
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
  .document-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
  @media (max-width: 640px) {
    .document-page {
      padding: 20px 18px 32px;
    }
  }
</style>
