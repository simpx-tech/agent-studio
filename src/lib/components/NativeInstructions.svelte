<script lang="ts">
  import { untrack } from 'svelte';
  import { RefreshCw, Copy, Check } from '@lucide/svelte';
  import type { ChatSettings } from '$lib/domain';
  import type { NativeInstructions } from '$lib/context';
  import { readNativeInstructions } from '$lib/transport';

  let { conversationId, settings }: { conversationId?: string; settings: ChatSettings } = $props();
  let snapshot = $state<NativeInstructions>();
  let loading = $state(false);
  let error = $state('');
  let refresh = $state(0);
  let copied = $state<number>();
  const key = $derived(
    JSON.stringify([conversationId, settings.provider, settings.connectionId, settings.model]),
  );
  let previousKey = '';
  $effect(() => {
    const selectedKey = key;
    refresh;
    let cancelled = false;
    untrack(() => {
      if (previousKey !== selectedKey) snapshot = undefined;
      previousKey = selectedKey;
      error = '';
      copied = undefined;
      if (!conversationId) {
        loading = false;
        return;
      }
      loading = true;
      readNativeInstructions(conversationId, {
        provider: settings.provider,
        connectionId: settings.connectionId,
      })
        .then((value) => {
          if (!cancelled) snapshot = value;
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            // No cached prompt after permission loss, scope changes, or provider record failures.
            snapshot = undefined;
            error = `Native instructions could not be read. ${String(reason).slice(0, 500)}`;
          }
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    });
    return () => {
      cancelled = true;
    };
  });
  const timestamp = (value: string | number) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown capture time' : date.toLocaleString();
  };
  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      copied = index;
    } catch {
      error = 'Could not copy the instructions. Select the text to copy it manually.';
    }
  }
</script>

<section class="native-instructions" aria-label="Recorded native instructions" aria-busy={loading}>
  <div class="native-heading">
    <strong>Recorded native instructions</strong>
    <button
      class="icon-button"
      aria-label="Refresh native instructions"
      title="Refresh native instructions"
      disabled={loading || !conversationId}
      onclick={() => refresh++}><RefreshCw size={15} class={loading ? 'spinning' : ''} /></button
    >
  </div>
  <p>
    Recorded by the CLI used for this conversation. Provider desktop apps can add further
    instructions.
  </p>
  {#if !conversationId}
    <p class="native-empty">
      Send the first message in this conversation to create a native session record.
    </p>
  {:else if error}<p class="error-banner" role="alert">{error}</p>{/if}
  {#if loading}<p role="status">
      {snapshot ? 'Updating recorded instructions…' : 'Reading the conversation’s native record…'}
    </p>{/if}
  {#if snapshot}
    <p class="native-notice">{snapshot.notice}</p>
    <p class="native-meta">
      Checked {timestamp(snapshot.checkedAt)} · {snapshot.blocks.length
        ? 'Recorded text'
        : 'Not available'}
    </p>
    {#each snapshot.blocks as block, index}
      <details class="native-block">
        <summary>{block.label}</summary>
        <div class="native-meta native-heading">
          <span
            >{block.version ? `CLI ${block.version}` : 'CLI version unknown'} · {block.capturedAt
              ? timestamp(block.capturedAt)
              : 'Capture time unknown'}{block.model ? ` · ${block.model}` : ''}</span
          >
          <button
            class="icon-button"
            aria-label={`Copy ${block.label} ${index + 1}`}
            title="Copy instructions"
            onclick={() => copy(block.text, index)}
            >{#if copied === index}<Check size={14} />{:else}<Copy size={14} />{/if}</button
          >
        </div>
        <pre aria-label={`${block.label} text`}>{block.text}</pre>
      </details>
    {/each}
    {#if snapshot.studioGuidance}
      <details class="native-block studio-guidance">
        <summary>Agent Studio additions · current app version</summary>
        <p>
          App guidance supplied as user context when a native conversation starts. This is the
          current app’s text; an older conversation may have started with different wording. Your
          conversation instructions appear separately above.
        </p>
        <pre aria-label="Current Agent Studio guidance">{snapshot.studioGuidance}</pre>
      </details>
    {/if}
  {/if}
</section>

<style>
  .native-instructions {
    font-size: 12px;
    line-height: 1.7;
    padding-top: 14px;
  }
  .native-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: space-between;
  }
  .native-heading strong {
    font-size: 12px;
  }
  p {
    color: #a6b49a;
    margin: 10px 0;
  }
  .native-meta {
    color: #91a680;
    font-size: 10px;
    overflow-wrap: anywhere;
  }
  .native-block {
    border-bottom: 1px solid #334329;
    padding: 12px 0;
  }
  summary {
    cursor: pointer;
    color: #d5dfca;
    overflow-wrap: anywhere;
  }
  pre {
    font:
      11px/1.7 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 12px;
    margin: 8px 0 0;
    background: #15200f;
    color: #cbd5c1;
    border-radius: 6px;
  }
  .native-empty,
  .native-notice {
    padding: 10px 0;
  }
  .studio-guidance {
    margin-top: 10px;
  }
</style>
