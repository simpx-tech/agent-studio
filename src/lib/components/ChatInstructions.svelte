<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { X } from '@lucide/svelte';
  let {
    instructions,
    close,
    save,
  }: { instructions: string; close: () => void; save: (value: string) => void } = $props();
  let draft = $state(untrack(() => instructions));
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
        save(draft);
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
      <footer>
        <button type="button" class="secondary" onclick={close}>Cancel</button><button
          class="primary"
          type="submit">Save instructions</button
        >
      </footer>
    </form>
  </div>
</div>
