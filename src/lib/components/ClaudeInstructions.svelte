<script lang="ts">
  import { ScrollText } from '@lucide/svelte';
  import {
    claudeInstructions,
    defaultClaudeInstructions,
    maxClaudeInstructions,
    storedClaudeInstructions,
  } from '$lib/claude-instructions';
  let {
    value,
    save,
  }: {
    value?: string;
    save: (value: string | undefined, previous: string | undefined) => Promise<void>;
  } = $props();
  // The saved value this draft started from; another device's change replaces an
  // unedited draft and makes a stale save fail instead of overwriting it.
  let base = $state<string | undefined>();
  let draft = $state('');
  let busy = $state(false);
  let error = $state('');
  let feedback = $state('');
  let loaded = false;
  const dirty = $derived(draft !== claudeInstructions({ claudeInstructions: base }));
  const summary = $derived(
    [
      draft === defaultClaudeInstructions
        ? 'Default instructions'
        : draft.trim()
          ? 'Custom instructions'
          : 'Off: Claude chats get no added instructions',
      `${draft.length.toLocaleString()} / ${maxClaudeInstructions.toLocaleString()} characters`,
      ...(dirty ? ['Unsaved changes'] : []),
    ].join(' · '),
  );
  $effect(() => {
    const incoming = value;
    if (loaded && (dirty || busy || incoming === base)) return;
    loaded = true;
    base = incoming;
    draft = claudeInstructions({ claudeInstructions: incoming });
  });
  async function store(next: string | undefined, message: string) {
    busy = true;
    error = '';
    feedback = '';
    try {
      await save(next, base);
      base = next;
      draft = claudeInstructions({ claudeInstructions: next });
      feedback = message;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // After a refused stale save, saving again deliberately replaces the newer value.
      base = value;
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="claude-instructions-heading">
  <h2 id="claude-instructions-heading"><ScrollText size={18} />Claude chat instructions</h2>
  <p>
    Added to the system prompt of every Claude chat that Agent Studio runs, in any folder. They sync
    with this workspace and apply from each chat's next reply. The Claude desktop app and terminal
    do not use them.
  </p>
  <textarea
    aria-label="Claude chat instructions"
    aria-describedby="claude-instructions-state"
    rows="6"
    maxlength={maxClaudeInstructions}
    disabled={busy}
    placeholder="No instructions are added to Claude chats."
    bind:value={draft}
    oninput={() => (feedback = '')}></textarea>
  <p id="claude-instructions-state" class="state">{summary}</p>
  <div class="actions">
    <button
      class="secondary"
      disabled={busy || !dirty}
      onclick={() => store(storedClaudeInstructions(draft), 'Saved for the next Claude reply.')}
      >{busy ? 'Saving…' : 'Save Claude instructions'}</button
    >
    <button
      class="text-button"
      disabled={busy || (base === undefined && !dirty)}
      onclick={() => store(undefined, 'Restored the default instructions.')}
      >Reset to default</button
    >
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if feedback}<p role="status">{feedback}</p>{/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  textarea {
    font-family: inherit;
    display: block;
    margin-top: 12px;
  }
  .state {
    font-size: var(--text-sm);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 12px 0 0;
  }
</style>
