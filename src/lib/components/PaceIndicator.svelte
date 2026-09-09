<script lang="ts">
  import { TrendingDown, MoveRight, TrendingUp, Minus } from '@lucide/svelte';
  import type { PaceTone } from '$lib/pace';

  let {
    label,
    tone,
    direction,
    description = '',
  }: {
    label: string;
    tone: PaceTone;
    direction: 'down' | 'right' | 'up' | 'unknown';
    description?: string;
  } = $props();
</script>

<span
  class={`pace-indicator tone-${tone}`}
  role="img"
  aria-label={label}
  title={description ? `${label}. ${description}` : label}
>
  {#if direction === 'down'}<TrendingDown size={16} aria-hidden="true" />
  {:else if direction === 'right'}<MoveRight size={16} aria-hidden="true" />
  {:else if direction === 'up'}<TrendingUp size={16} aria-hidden="true" />
  {:else}<Minus size={16} aria-hidden="true" />{/if}
</span>
