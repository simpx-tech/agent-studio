<script lang="ts">
  import type { Workflow } from '@lucide/svelte';

  // An empty list in the sidebar: a quiet icon above one short line.
  let { icon: Icon, title }: { icon: typeof Workflow; title: string } = $props();
</script>

<div class="sidebar-empty-state">
  <span class="empty-icon" aria-hidden="true"><Icon size={17} /></span>
  <p>{title}</p>
</div>

<style>
  .sidebar-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 12px 16px;
    text-align: center;
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    color: var(--text-muted);
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }
</style>
