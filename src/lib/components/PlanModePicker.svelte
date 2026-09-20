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
      title="Mode for the next message"
      value={settings.planMode ? 'plan' : 'build'}
      options={[
        { id: 'build', name: 'Build', detail: 'Work with full tool access.' },
        { id: 'plan', name: 'Plan', detail: 'Explore and propose changes before implementation.' },
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
    width: 105px;
    min-width: 90px;
  }
</style>
