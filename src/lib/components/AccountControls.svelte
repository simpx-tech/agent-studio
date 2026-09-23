<script lang="ts">
  import { untrack } from 'svelte';
  import type { UsageSnapshot } from '$lib/usage';
  import { canResetUsage, workspaceMessagesSchema, type WorkspaceMessages } from '$lib/live-usage';
  import {
    manageAccount,
    redeemResetCredit,
    hasPendingReset,
    workspaceStorageScope,
    watchRelayConnection,
  } from '$lib/transport';
  import { onMount } from 'svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    provider,
    connectionId,
    name = 'this Codex account',
    snapshot,
    disabled = false,
  }: {
    provider: string;
    connectionId?: string;
    name?: string;
    snapshot?: UsageSnapshot;
    disabled?: boolean;
  } = $props();
  let messages = $state<WorkspaceMessages>();
  let messageError = $state('');
  let result = $state('');
  let confirmation = $state(false);
  let busy = $state(false);
  let retry = $state(false);
  let generation = 0;
  const limitStatus = $derived(snapshot?.live?.limitStatus);
  const accountChange = $derived(snapshot?.live?.accountChanged ?? '');
  onMount(() =>
    watchRelayConnection((ready) => {
      if (!ready) {
        generation++;
        messages = undefined;
        confirmation = false;
        result = '';
      }
    }),
  );
  $effect(() => {
    const id = connectionId,
      currentProvider = provider,
      changed = accountChange,
      unavailable = disabled;
    void changed;
    const current = ++generation;
    messages = undefined;
    messageError = '';
    confirmation = false;
    result = '';
    busy = false;
    retry = id ? untrack(() => hasPendingReset(id)) : false;
    if (currentProvider !== 'codex' || !id || unavailable) return;
    const scope = untrack(workspaceStorageScope);
    untrack(() => {
      void manageAccount(id, { action: 'workspaceMessages' })
        .then((value) => {
          if (current === generation && scope === workspaceStorageScope())
            messages = workspaceMessagesSchema.parse(value);
        })
        .catch(() => {
          if (current === generation && scope === workspaceStorageScope())
            messageError = 'Workspace notices are unavailable for this CLI or account.';
        });
    });
    return () => {
      generation++;
    };
  });
  async function redeem() {
    if (!connectionId || disabled || busy) return;
    const id = connectionId,
      current = generation,
      scope = workspaceStorageScope();
    busy = true;
    result = '';
    try {
      const outcome = await redeemResetCredit(id);
      if (current !== generation || scope !== workspaceStorageScope()) return;
      result =
        outcome === 'reset'
          ? 'One reset credit used. Refreshing account limits…'
          : outcome === 'alreadyRedeemed'
            ? 'This reset was already applied. Refreshing account limits…'
            : outcome === 'noCredit'
              ? 'No reset credit is available.'
              : 'No usage window is eligible for a reset.';
      retry = false;
      confirmation = false;
    } catch (error) {
      if (current !== generation || scope !== workspaceStorageScope()) return;
      result = String(error).replace(/^Error: /, '');
      retry = true;
      confirmation = false;
    } finally {
      if (current === generation) busy = false;
    }
  }
</script>

{#if provider === 'claude' && limitStatus && limitStatus.status !== 'allowed'}
  <p class="account-note" role="status">
    {limitStatus.status === 'rejected'
      ? 'Claude reported a rate limit.'
      : 'Claude reports that usage is approaching a limit.'}{limitStatus.usingOverage
      ? ' Extra usage is active.'
      : ''}{limitStatus.resetsAt
      ? ` Resets ${new Date(limitStatus.resetsAt * 1000).toLocaleString()}.`
      : ''}
  </p>
{/if}
{#if provider === 'codex' && connectionId}
  <section class="account-controls" aria-label={`Account updates for ${name}`}>
    {#if snapshot?.live?.planType}<p class="account-note">Plan: {snapshot.live.planType}</p>{/if}
    {#if canResetUsage(snapshot) || retry}
      <button
        class="text-button"
        disabled={disabled || busy}
        onclick={() => {
          confirmation = true;
        }}>{retry ? 'Retry usage reset' : 'Use a reset credit'}</button
      >
    {/if}
    {#if result}<p class="account-note" role="status">{result}</p>{/if}
    {#each messages?.messages ?? [] as message (message.messageId)}
      <p class="workspace-message">
        <strong>Workspace notice</strong><span>{message.messageBody}</span>
      </p>
    {/each}
    {#if messageError}<p class="account-note">{messageError}</p>{/if}
  </section>
{/if}
{#if confirmation && connectionId}
  <ConnectionDialog
    title="Use one reset credit?"
    {busy}
    close={() => {
      confirmation = false;
    }}
  >
    <p>
      Use one earned reset credit for <strong>{name}</strong>? Eligible limits are reset across this
      account, including other chats.
    </p>
    {#if retry}<p>
        This retries the same redemption attempt. It will not request a second credit.
      </p>{/if}
    <div class="actions">
      <button
        class="secondary"
        disabled={busy}
        onclick={() => {
          confirmation = false;
        }}>Cancel</button
      ><button class="primary" disabled={busy || disabled} onclick={redeem}
        >{busy ? 'Checking reset…' : retry ? 'Retry same reset' : 'Use one credit'}</button
      >
    </div>
  </ConnectionDialog>
{/if}

<style>
  .account-controls {
    min-width: 0;
    margin-top: 12px;
  }
  .account-note,
  .workspace-message {
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .workspace-message {
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--hover);
  }
  .workspace-message strong {
    color: var(--text-secondary);
    font-weight: 600;
  }
  .workspace-message span {
    display: block;
    margin-top: 2px;
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
  }
</style>
