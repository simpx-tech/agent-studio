<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Ellipsis } from '@lucide/svelte';
  let { children }: { children: Snippet } = $props();
  let open = $state(false);
  let root: HTMLDivElement;
</script>

<svelte:document
  onpointerdown={(event) => {
    if (!root?.contains(event.target as Node)) open = false;
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') open = false;
  }}
/>
<div class="toolbar-actions" bind:this={root}>
  <button
    class="icon-button mobile-actions-toggle"
    aria-label="Conversation actions"
    aria-expanded={open}
    onclick={() => (open = !open)}><Ellipsis size={21} /></button
  >
  <div class="action-items" class:open>{@render children()}</div>
</div>

<style>
  .toolbar-actions {
    position: relative;
    flex-shrink: 0;
  }
  .action-items {
    display: flex;
    gap: 2px;
  }
  .mobile-actions-toggle {
    display: none;
  }
  @media (max-width: 1100px) {
    .action-items {
      gap: 0;
    }
  }
  @media (max-width: 650px) {
    .mobile-actions-toggle {
      display: flex;
      width: 44px;
      height: 44px;
    }
    .action-items {
      display: none;
    }
    .action-items.open {
      display: grid;
      grid-template-columns: repeat(3, 44px);
      gap: 4px;
      position: absolute;
      right: 0;
      top: 48px;
      z-index: 31;
      padding: 6px;
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-lg);
    }
    .action-items :global(.icon-button) {
      width: 44px;
      height: 44px;
    }
  }
</style>
