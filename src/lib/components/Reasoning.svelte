<script lang="ts">
  import { Brain, ChevronDown } from '@lucide/svelte';
  import type { ContentBlock } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';

  let { blocks }: { blocks: ContentBlock[] } = $props();
  const reasoning = $derived(blocks.filter((block) => block.type === 'reasoning'));
  let linkError = $state('');
  function linkClick(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      void openLink(link.href).catch(() => (linkError = 'Could not open this link.'));
    }
  }
</script>

{#if reasoning.length}
  <details class="reasoning-panel">
    <summary aria-label="Reasoning" title="Reasoning text reported by the provider">
      <Brain size={14} aria-hidden="true" /><span>Reasoning</span>
      <ChevronDown size={13} class="disclosure" aria-hidden="true" />
    </summary>
    <div class="reasoning-body">
      {#each reasoning as block (block.id)}
        <!-- Sanitized Markdown links retain keyboard behavior through their anchors. -->
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div class="prose reasoning-text" onclick={linkClick}>
          {@html renderMarkdown(block.text)}
        </div>
        {#if block.truncated}<p class="muted small">
            Reasoning display limit reached. This section is incomplete.
          </p>{/if}
      {/each}
      {#if linkError}<p role="alert">{linkError}</p>{/if}
    </div>
  </details>
{/if}

<style>
  .reasoning-panel {
    margin: 2px 0 12px;
    min-width: 0;
    color: var(--text-muted);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 7px;
    width: fit-content;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 500;
    list-style: none;
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--hover);
    color: var(--text);
  }
  summary :global(.disclosure) {
    color: var(--text-faint);
  }
  details[open] :global(.disclosure) {
    transform: rotate(180deg);
  }
  .reasoning-body {
    margin-top: 8px;
    padding: 2px 0 2px 14px;
    border-left: 2px solid var(--border-strong);
    overflow-wrap: anywhere;
  }
  .reasoning-text {
    font-size: var(--text-base);
    color: var(--text-muted);
  }
  .reasoning-text + .reasoning-text {
    margin-top: 12px;
  }
</style>
