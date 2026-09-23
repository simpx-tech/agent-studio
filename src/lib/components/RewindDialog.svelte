<script lang="ts">
  import { untrack } from 'svelte';
  import { messageText, type Conversation } from '$lib/domain';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    conversation,
    messageId,
    close,
    apply,
  }: {
    conversation: Conversation;
    messageId?: string;
    close: () => void;
    apply: (id: string) => Promise<void>;
  } = $props();
  let selected = $state(
    untrack(() => messageId ?? conversation.messages.findLast((m) => m.role === 'user')?.id ?? ''),
  );
  let busy = $state(false);
  let error = $state('');
  const choices = $derived(
    conversation.messages
      .filter((m) => m.role === 'user')
      .map((m, i) => ({
        id: m.id,
        name: `${i + 1}. ${messageText(m).slice(0, 100) || 'Image message'}`,
      })),
  );
  const count = $derived(
    conversation.messages.length - conversation.messages.findIndex((m) => m.id === selected),
  );
  async function confirm() {
    if (busy || !selected) return;
    busy = true;
    error = '';
    try {
      await apply(selected);
      close();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<ConnectionDialog title="Rewind conversation" {busy} {close}>
  <form
    aria-busy={busy}
    onsubmit={(event) => {
      event.preventDefault();
      void confirm();
    }}
  >
    <p>Return to before this message. Your draft stays as it is.</p>
    <ChoicePicker
      field
      label="Rewind to message"
      options={choices}
      value={selected}
      disabled={busy}
      onchange={(id) => (selected = id)}
    />
    <p>
      {count}
      {count === 1 ? 'message' : 'messages'} will be set aside. You can undo this rewind until you send
      another message. Files stay as they are.
    </p>
    <p>
      The next reply starts a new agent session from the retained messages. Earlier tool details are
      not carried over.
    </p>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}>Cancel</button><button
        type="submit"
        class="primary"
        disabled={busy || !selected}>{busy ? 'Rewinding…' : 'Rewind'}</button
      >
    </div>
  </form>
</ConnectionDialog>
