<script lang="ts">
  import { BookOpen } from '@lucide/svelte';
  import type { ChatSettings } from '$lib/domain';
  import ChoicePicker from './ChoicePicker.svelte';
  let {
    settings,
    disabled,
    change,
  }: { settings: ChatSettings; disabled: boolean; change: (settings: ChatSettings) => void } =
    $props();
</script>

{#if settings.provider !== 'gemini'}
  <div class="mode-picker">
    <ChoicePicker
      label="Mode"
      value={settings.planMode ? 'plan' : 'build'}
      options={[
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ]}
      {disabled}
      onchange={(value) => change({ ...settings, planMode: value === 'plan' })}
    >
      {#snippet icon()}<BookOpen size={16} />{/snippet}
    </ChoicePicker>
  </div>
{/if}

<style>
  .mode-picker {
    flex-shrink: 0;
    min-width: 0;
  }
</style>
