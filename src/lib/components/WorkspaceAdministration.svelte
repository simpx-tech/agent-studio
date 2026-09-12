<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Copy, Plus, RefreshCw, Settings2, ShieldCheck } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import {
    createManagedWorkspace,
    disableManagedWorkspace,
    readWorkspaceAdministration,
    relayConnectionGeneration,
    rotateManagedWorkspaceKey,
    updateManagedWorkspace,
    workspaceStorageScope,
    watchRelayConnection,
    WorkspaceAdministrationError,
    type ManagedWorkspace,
    type WorkspaceAdministration,
    type WorkspaceRole,
  } from '$lib/transport';

  let { paired, workspaceSession = 0 }: { paired: boolean; workspaceSession?: number } = $props();
  type Dialog = 'create' | 'manage' | 'grant' | 'role' | 'rotate' | 'disable' | 'key' | null;
  let administration = $state<WorkspaceAdministration | null>(null);
  let dialog = $state<Dialog>(null);
  let selectedId = $state('');
  let name = $state('');
  let role = $state<WorkspaceRole>('member');
  let secret = $state('');
  let issuedName = $state('');
  let busy = $state(false);
  let refreshing = $state(false);
  let accessVerified = $state(false);
  let refreshError = $state('');
  let error = $state('');
  let feedback = $state('');
  let copied = $state(false);
  let alive = true;
  let lifetime = 0;
  let refreshRevision = 0;
  let dialogRevision = 0;
  const isAdmin = $derived(administration?.role === 'admin');
  const workspaces = $derived(administration?.workspaces ?? []);
  const selected = $derived(workspaces.find((workspace) => workspace.id === selectedId));
  const protectedKey = $derived(
    selectedId === 'owner' || selectedId === administration?.workspaceId,
  );
  const roleOptions = [
    { id: 'member', name: 'Member', detail: 'Uses this workspace’s chats and computers.' },
    {
      id: 'admin',
      name: 'Administrator',
      detail: 'Also manages workspaces and issues access keys.',
    },
  ];

  function guard() {
    const generation = lifetime;
    const scope = workspaceStorageScope();
    const relayGeneration = relayConnectionGeneration();
    return () =>
      alive &&
      paired &&
      generation === lifetime &&
      !!scope &&
      scope === workspaceStorageScope() &&
      relayGeneration !== null &&
      relayGeneration === relayConnectionGeneration();
  }
  function clearDialog() {
    ++dialogRevision;
    dialog = null;
    selectedId = name = secret = issuedName = error = '';
    role = 'member';
    copied = false;
  }
  function clearAccess() {
    ++lifetime;
    ++refreshRevision;
    administration = null;
    accessVerified = false;
    refreshError = '';
    refreshing = busy = false;
    feedback = '';
    clearDialog();
  }
  async function refresh() {
    if (!paired || !alive || refreshing || document.visibilityState === 'hidden') return;
    const current = guard();
    const revision = ++refreshRevision;
    refreshing = true;
    try {
      const next = await readWorkspaceAdministration();
      if (!current() || revision !== refreshRevision) return;
      if (next?.role !== 'admin' || !Array.isArray(next.workspaces)) {
        clearAccess();
        return;
      }
      administration = next;
      accessVerified = true;
      refreshError = '';
      if (selectedId && !next.workspaces.some((workspace) => workspace.id === selectedId))
        clearDialog();
    } catch (failure) {
      if (current() && revision === refreshRevision) {
        if (failure instanceof WorkspaceAdministrationError && [401, 403].includes(failure.status))
          clearAccess();
        else {
          accessVerified = false;
          refreshError = 'Could not verify administrator access. Refresh before making changes.';
        }
      }
    } finally {
      if (current() && revision === refreshRevision) refreshing = false;
    }
  }
  $effect(() => {
    const connected = paired;
    workspaceSession;
    untrack(() => {
      clearAccess();
      if (connected) void refresh();
    });
  });
  onMount(() => {
    const stopRelay = watchRelayConnection((ready) => {
      clearAccess();
      if (ready && paired) void refresh();
    });
    const onReturn = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const timer = setInterval(onReturn, 15_000);
    return () => {
      alive = false;
      stopRelay();
      clearAccess();
      clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  });
  function create() {
    if (!isAdmin || !accessVerified || busy) return;
    clearDialog();
    feedback = '';
    dialog = 'create';
  }
  function manage(workspace: ManagedWorkspace) {
    if (!isAdmin || !accessVerified || busy) return;
    clearDialog();
    feedback = '';
    selectedId = workspace.id;
    name = workspace.name;
    role = workspace.role;
    dialog = 'manage';
  }
  async function mutate(
    action: () => Promise<{ workspace: ManagedWorkspace; token?: string } | null>,
  ) {
    if (!isAdmin || !accessVerified || busy) return;
    const current = guard();
    ++refreshRevision;
    refreshing = false;
    busy = true;
    error = feedback = '';
    try {
      const result = await action();
      if (!current()) return;
      ++refreshRevision;
      refreshing = false;
      if (!result?.workspace) throw new Error('The server did not confirm this workspace change.');
      const next = result.workspace;
      administration = {
        ...administration!,
        workspaces: [...workspaces.filter((workspace) => workspace.id !== next.id), next].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      };
      if (next.id === administration.workspaceId && next.role !== 'admin') {
        clearAccess();
        return;
      }
      clearDialog();
      if (result.token) {
        secret = result.token;
        issuedName = next.name;
        selectedId = next.id;
        dialog = 'key';
      } else feedback = 'Workspace updated.';
      void refresh();
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof WorkspaceAdministrationError && [401, 403].includes(failure.status)) {
        clearAccess();
        return;
      }
      error = failure instanceof Error ? failure.message : 'Could not update this workspace.';
    } finally {
      if (current()) busy = false;
    }
  }
  function save() {
    if (!name.trim() || busy || !accessVerified) return;
    if (dialog === 'create') {
      if (role === 'admin') dialog = 'grant';
      else void mutate(() => createManagedWorkspace(name.trim(), role));
    } else if (selected) {
      if (role !== selected.role) dialog = 'role';
      else void mutate(() => updateManagedWorkspace(selectedId, name.trim(), role));
    }
  }
  async function copyKey() {
    if (!secret || !isAdmin) return;
    const current = guard();
    const revision = dialogRevision;
    try {
      await navigator.clipboard.writeText(secret);
      if (current() && revision === dialogRevision) copied = true;
    } catch {
      if (current() && revision === dialogRevision)
        error = 'Could not copy the key. Select it and copy manually.';
    }
  }
</script>

{#if paired && isAdmin}
  <section class="workspace-administration" aria-labelledby="workspace-administration-heading">
    <div class="administration-heading">
      <h2 id="workspace-administration-heading">
        <ShieldCheck size={18} />Workspace administration
      </h2>
      <button
        class="icon-button"
        aria-label="Refresh workspaces"
        disabled={refreshing || busy}
        onclick={refresh}><RefreshCw size={16} /></button
      >
    </div>
    <p>
      Administrators manage workspace access and issue keys that grant access to a workspace. Chats
      and computer setups stay in their own workspaces.
    </p>
    <ul class="workspace-admin-list">
      {#each workspaces as workspace (workspace.id)}
        <li class="workspace-admin-row" data-workspace-id={workspace.id}>
          <div class="workspace-summary">
            <strong>{workspace.name}</strong>
            <span
              >{workspace.role === 'admin' ? 'Administrator' : 'Member'} · {workspace.enabled
                ? 'Enabled'
                : 'Disabled'}{workspace.id === administration?.workspaceId
                ? ' · This workspace'
                : ''}</span
            >
          </div>
          <button
            class="text-button"
            aria-label={`Manage workspace ${workspace.name}`}
            disabled={busy || !accessVerified}
            onclick={() => manage(workspace)}><Settings2 size={15} /><span>Manage</span></button
          >
        </li>
      {/each}
    </ul>
    <button class="secondary" disabled={busy || !accessVerified} onclick={create}
      ><Plus size={15} />Create workspace</button
    >
    {#if feedback}<p role="status">{feedback}</p>{/if}
    {#if !dialog}{@render accessWarning()}{/if}
  </section>

  {#if dialog === 'create' || dialog === 'manage'}
    <ConnectionDialog
      title={dialog === 'create' ? 'Create workspace' : 'Manage workspace'}
      {busy}
      close={clearDialog}
    >
      {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
      {@render accessWarning()}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label
          >Workspace name<input
            aria-label="Workspace name"
            bind:value={name}
            maxlength="80"
            autocomplete="off"
            required
            disabled={busy}
          /></label
        >
        <div class="fleet-field">
          <span>Role</span><ChoicePicker
            label="Workspace role"
            options={roleOptions}
            value={role}
            field
            disabled={busy}
            onchange={(value) => (role = value as WorkspaceRole)}
          />
        </div>
        <p>
          Members use their own chats, computers, and agent connections. Administrators can also
          manage other workspaces and issue keys.
        </p>
        {#if dialog === 'manage' && selected}
          <div class="workspace-key-actions">
            {#if protectedKey}<p>
                {selectedId === 'owner'
                  ? 'The owner workspace key is managed in the server configuration.'
                  : 'Ask another administrator to rotate the key or disable this workspace.'}
              </p>{/if}
            <button
              class="secondary"
              type="button"
              disabled={busy || !accessVerified || protectedKey}
              onclick={() => {
                error = '';
                dialog = 'rotate';
              }}>Rotate key</button
            >
            <button
              class="text-button"
              type="button"
              disabled={busy || !accessVerified || protectedKey || !selected.enabled}
              onclick={() => {
                error = '';
                dialog = 'disable';
              }}>Disable workspace</button
            >
            {#if !selected.enabled}<p>
                Rotating the key enables this workspace again. Its saved chats and settings are
                retained.
              </p>{/if}
          </div>
        {/if}
        <div class="dialog-actions">
          <button class="secondary" type="button" disabled={busy} onclick={clearDialog}
            >Cancel</button
          ><button class="primary" disabled={busy || !accessVerified || !name.trim()}
            >{busy ? 'Saving…' : dialog === 'create' ? 'Create workspace' : 'Save changes'}</button
          >
        </div>
      </form>
    </ConnectionDialog>
  {:else if dialog === 'key'}
    <ConnectionDialog title="Workspace key" close={clearDialog}>
      <div class="key-disclosure">
        {@render accessWarning()}
        <p>
          <strong>{issuedName}</strong> is ready. Copy this key now and give it only to people who should
          access this workspace. It will not be shown again after you close this dialog.
        </p>
        <label
          >New workspace key<textarea
            aria-label="New workspace key"
            value={secret}
            readonly
            rows="3"
            spellcheck="false"
            autocomplete="off"></textarea></label
        >
        {#if error}<p role="alert">{error}</p>{/if}
        {#if copied}<p role="status">Key copied.</p>{/if}
        <div class="dialog-actions">
          <button class="secondary" onclick={copyKey}><Copy size={15} />Copy key</button><button
            class="primary"
            onclick={clearDialog}>Done</button
          >
        </div>
      </div>
    </ConnectionDialog>
  {:else if dialog}
    <ConnectionDialog
      title={dialog === 'grant'
        ? 'Grant administrator access'
        : dialog === 'role'
          ? 'Change workspace role'
          : dialog === 'rotate'
            ? 'Rotate workspace key'
            : 'Disable workspace'}
      {busy}
      close={() => {
        error = '';
        dialog = dialog === 'grant' ? 'create' : 'manage';
      }}
    >
      <div class="workspace-confirmation">
        {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
        {@render accessWarning()}
        {#if dialog === 'grant' || (dialog === 'role' && role === 'admin')}
          <p>
            Make <strong>{name}</strong> an administrator? Anyone using this workspace can manage other
            workspaces and issue keys that grant access to them.
          </p>
        {:else if dialog === 'role'}
          <p>
            Change <strong>{name}</strong> to a member? It will lose workspace administration
            access. {selectedId === administration?.workspaceId
              ? 'Your administration controls will close after this change.'
              : ''} At least one enabled administrator must remain.
          </p>
        {:else if dialog === 'rotate'}
          <p>
            Replace the key for <strong>{selected?.name}</strong>? Its current key and browser
            sessions will stop working. Devices must pair again with the new key. Saved chats and
            settings are kept.
          </p>
        {:else}
          <p>
            Disable access to <strong>{selected?.name}</strong>? Its computers and browsers will
            disconnect. Saved chats and settings are kept; rotating its key will enable access
            again.
          </p>
        {/if}
        <div class="dialog-actions">
          <button
            class="secondary"
            disabled={busy}
            onclick={() => {
              error = '';
              dialog = dialog === 'grant' ? 'create' : 'manage';
            }}>Back</button
          >
          <button
            class="primary"
            disabled={busy || !accessVerified}
            onclick={() => {
              if (dialog === 'grant') void mutate(() => createManagedWorkspace(name.trim(), role));
              else if (dialog === 'role')
                void mutate(() => updateManagedWorkspace(selectedId, name.trim(), role));
              else if (dialog === 'rotate' && !protectedKey)
                void mutate(() => rotateManagedWorkspaceKey(selectedId));
              else if (dialog === 'disable' && !protectedKey)
                void mutate(() => disableManagedWorkspace(selectedId));
            }}
            >{busy
              ? 'Saving…'
              : dialog === 'grant'
                ? 'Create administrator workspace'
                : dialog === 'role'
                  ? 'Change role'
                  : dialog === 'rotate'
                    ? 'Rotate key'
                    : 'Disable workspace'}</button
          >
        </div>
      </div>
    </ConnectionDialog>
  {/if}
{/if}

{#snippet accessWarning()}
  {#if refreshError}
    <p role="alert">{refreshError}</p>
    <button class="text-button" type="button" disabled={refreshing} onclick={refresh}
      >Check administrator access</button
    >
  {/if}
{/snippet}

<style>
  .workspace-administration {
    border-top: 1px solid var(--line);
    padding-top: 24px;
  }
  .administration-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    margin: 0;
  }
  p {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
    margin: 10px 0;
  }
  .workspace-admin-list {
    list-style: none;
    margin: 16px 0;
    padding: 0;
  }
  .workspace-admin-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--line);
    padding: 12px 0;
  }
  .workspace-summary {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .workspace-summary strong {
    overflow-wrap: anywhere;
    font-size: 13px;
    font-weight: 600;
  }
  .workspace-summary span {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .workspace-admin-row button {
    flex-shrink: 0;
  }
  .workspace-key-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }
  .workspace-key-actions p {
    width: 100%;
  }
  .key-disclosure,
  .workspace-confirmation {
    display: grid;
    gap: 18px;
  }
  .key-disclosure textarea {
    min-width: 0;
    width: 100%;
    resize: none;
    font: 12px/1.6 var(--font-mono, monospace);
    overflow-wrap: anywhere;
  }
  [role='alert'] {
    color: #e5a29b;
  }
  @media (max-width: 420px) {
    .workspace-admin-row {
      gap: 8px;
    }
    .workspace-admin-row button span {
      display: none;
    }
    h2 {
      font-size: 15px;
    }
  }
</style>
