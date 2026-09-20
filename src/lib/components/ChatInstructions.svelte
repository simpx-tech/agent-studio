<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { X } from '@lucide/svelte';
  import { outputSchemaError } from '$lib/structured-output';
  let {
    instructions,
    outputSchema,
    provider,
    close,
    save,
  }: {
    instructions: string;
    outputSchema?: string;
    provider: string;
    close: () => void;
    save: (value: string, schema?: string) => void;
  } = $props();
  let draft = $state(untrack(() => instructions));
  let schema = $state(untrack(() => outputSchema ?? ''));
  const schemaError = $derived(schema.trim() ? outputSchemaError(schema) : undefined);
  let input: HTMLTextAreaElement;
  onMount(() => input.focus());
</script>

<div class="modal-backdrop" role="presentation">
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="instructions-title"
    tabindex="-1"
  >
    <header>
      <div>
        <span class="eyebrow">JUST FOR THIS CONVERSATION</span>
        <h2 id="instructions-title">Chat instructions</h2>
      </div>
      <button class="icon-button" onclick={close} aria-label="Close chat instructions"
        ><X size={20} /></button
      >
    </header>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (!schemaError) save(draft, schema.trim() || undefined);
      }}
    >
      <label
        >Instructions<textarea
          bind:this={input}
          bind:value={draft}
          rows="8"
          maxlength="16000"
          placeholder="Optional guidance on tone, role, or how to approach this conversation."
        ></textarea></label
      >
      <p class="field-hint">
        Applies to the next reply in this chat. New conversations start with no custom instructions.
      </p>
      {#if provider === 'claude' || provider === 'codex'}
        <label
          >Structured output · JSON Schema<textarea
            bind:value={schema}
            rows="7"
            spellcheck="false"
            maxlength="16000"
            placeholder={'{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'}
            aria-describedby="output-schema-hint"
            aria-invalid={!!schemaError}></textarea></label
        >
        <p id="output-schema-hint" class="field-hint">
          Optional. Constrains replies to a JSON object. Leave empty for normal replies. The
          provider checks supported schema rules. Context compaction is unaffected.
        </p>
        {#if schemaError}<p role="alert">{schemaError}</p>{/if}
      {/if}
      <footer>
        <button type="button" class="secondary" onclick={close}>Cancel</button><button
          class="primary"
          type="submit"
          disabled={!!schemaError}>Save instructions</button
        >
      </footer>
    </form>
  </div>
</div>

<style>
  .modal {
    max-height: calc(100dvh - 32px);
    display: flex;
    flex-direction: column;
  }
  form {
    overflow-y: auto;
    min-height: 0;
  }
  textarea {
    font-family: inherit;
  }
  textarea[spellcheck='false'] {
    font-family: monospace;
    font-size: 12px;
  }
</style>
