<script lang="ts">
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  let {
    text,
    complete = true,
    truncated = false,
    running = false,
  }: {
    text: string;
    complete?: boolean;
    truncated?: boolean;
    running?: boolean;
  } = $props();
  let error = $state('');
  function linkClick(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      void openLink(link.href).catch(() => (error = 'Could not open this link.'));
    }
  }
</script>

<section class="proposed-plan" aria-label="Proposed plan">
  <h4>Proposed plan</h4>
  {#if !complete}<p class="muted small">
      {running ? 'Drafting plan…' : 'Plan was not completed.'}
    </p>{/if}
  <!-- Sanitized Markdown only; anchors supply keyboard interaction. -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="prose" onclick={linkClick}>{@html renderMarkdown(text)}</div>
  {#if truncated}<p class="muted small">
      This plan exceeds the display limit. Only part is shown.
    </p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .proposed-plan {
    margin: 14px 0;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  h4 {
    font-size: 13px;
    margin: 0 0 10px;
  }
</style>
