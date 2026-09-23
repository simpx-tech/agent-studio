<script lang="ts">
  import { onMount } from 'svelte';
  import { undoFiles } from '$lib/transport';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    conversationId,
    runId,
    connectionId,
    close,
    prepare,
    applied,
  }: {
    conversationId: string;
    runId: string;
    connectionId?: string;
    close: () => void;
    prepare: () => Promise<void>;
    applied: () => Promise<void>;
  } = $props();
  let files = $state<string[]>([]);
  // Checking can be abandoned; once files are being restored, the dialog stays open.
  let checking = $state(true);
  let busy = $state(false);
  let error = $state('');
  let undone = $state(false);
  onMount(() => {
    let disposed = false;
    void (async () => {
      try {
        await prepare();
        if (disposed) return;
        const preview = await undoFiles(conversationId, runId, connectionId);
        if (disposed) return;
        files = preview.files;
        undone = preview.undone;
        if (undone) await applied();
      } catch (e) {
        if (!disposed) error = String(e);
      } finally {
        if (!disposed) checking = false;
      }
    })();
    return () => {
      disposed = true;
    };
  });
  async function confirm() {
    if (busy || checking || !files.length) return;
    busy = true;
    error = '';
    try {
      await prepare();
      if (!undone) {
        const result = await undoFiles(conversationId, runId, connectionId, true);
        undone = result.undone;
      }
      await applied();
      close();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<ConnectionDialog title="Undo file edits" {busy} {close}>
  <form
    aria-busy={busy || checking}
    onsubmit={(event) => {
      event.preventDefault();
      void confirm();
    }}
  >
    <p>
      Restore the files this response changed. Files it created are removed. The conversation stays
      as it is.
    </p>
    <p>
      Only recorded file edits are included; shell commands and external actions are not undone. A
      file changed since this response blocks Undo.
    </p>
    {#if checking}<p role="status">Checking files on the execution computer…</p>{/if}
    {#if files.length}<ul class="undo-files" aria-label="Files to restore">
        {#each files as file (file)}<li>{file}</li>{/each}
      </ul>{/if}
    {#if undone}<p role="status">These edits have been undone.</p>{/if}
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}
        >{undone ? 'Close' : 'Cancel'}</button
      ><button type="submit" class="primary" disabled={busy || checking || !files.length}
        >{busy ? 'Restoring…' : undone ? 'Save status' : 'Undo edits'}</button
      >
    </div>
  </form>
</ConnectionDialog>

<style>
  .undo-files {
    display: grid;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
    margin: 0;
    padding: 8px 12px;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .undo-files li {
    overflow-wrap: anywhere;
  }
</style>
