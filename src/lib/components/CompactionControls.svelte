<script lang="ts">
  import ChoicePicker from './ChoicePicker.svelte';
  import type { ChatSettings } from '$lib/domain';
  let {
    settings,
    canCompact,
    compact,
    disabled,
    change,
  }: {
    settings: ChatSettings;
    canCompact: boolean;
    compact: () => void;
    disabled: boolean;
    change: (tokens?: number) => void;
  } = $props();
  let custom = $state(false);
  let tokens = $state<number | undefined>(200000);
  const options = $derived([
    { id: 'auto', name: 'Automatic' },
    ...Array.from(
      new Set([
        100000,
        200000,
        500000,
        1000000,
        ...(settings.autoCompactTokens ? [settings.autoCompactTokens] : []),
      ]),
    )
      .sort((a, b) => a - b)
      .map((n) => ({ id: String(n), name: `${n.toLocaleString()} tokens` })),
    { id: 'custom', name: 'Custom size…' },
  ]);
</script>

{#if settings.provider === 'claude' || settings.provider === 'codex'}
  <div class="compaction-controls">
    <button type="button" class="button secondary small" disabled={!canCompact} onclick={compact}
      >Compact context</button
    >
    {#if settings.provider === 'claude'}
      <ChoicePicker
        label="Claude auto-compaction window"
        field
        value={custom ? 'custom' : String(settings.autoCompactTokens ?? 'auto')}
        {options}
        {disabled}
        onchange={(value) => {
          custom = value === 'custom';
          if (!custom) change(value === 'auto' ? undefined : Number(value));
        }}
      />
      {#if custom}
        <div class="custom-size">
          <input
            aria-label="Auto-compaction tokens"
            type="number"
            min="1"
            step="1"
            bind:value={tokens}
            {disabled}
          />
          <button
            type="button"
            class="button secondary small"
            disabled={disabled || !Number.isInteger(tokens) || !tokens || tokens < 1}
            onclick={() => {
              change(tokens);
              custom = false;
            }}>Apply</button
          >
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .compaction-controls {
    display: grid;
    gap: 8px;
  }
  .compaction-controls > button {
    justify-self: start;
  }
  .custom-size {
    display: flex;
    gap: 6px;
  }
  input {
    min-width: 0;
    width: 100%;
  }
</style>
