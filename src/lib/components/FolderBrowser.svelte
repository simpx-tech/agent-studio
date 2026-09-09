<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUp, Folder, ChevronRight, RefreshCw, House } from '@lucide/svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import type { Environment } from '$lib/fleet';
  import type { ChatLocation } from '$lib/domain';
  import type { FolderListing } from '$lib/transport';
  let {
    computerId,
    computerName,
    environments,
    initialEnvironment,
    browse,
    choose,
    close,
  }: {
    computerId: string;
    computerName: string;
    environments: Environment[];
    initialEnvironment?: string;
    browse: (environmentId: string, path?: string) => Promise<FolderListing>;
    choose: (location: ChatLocation) => Promise<void>;
    close: () => void;
  } = $props();
  let environmentId = $state('');
  let path = $state('');
  let listing = $state<FolderListing>();
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let generation = 0;
  async function load(next = '') {
    const token = ++generation;
    loading = true;
    error = '';
    listing = undefined;
    path = next;
    try {
      const result = await browse(environmentId, next);
      if (token !== generation) return;
      listing = result;
      path = result.path;
    } catch (e) {
      if (token === generation) error = String(e);
    } finally {
      if (token === generation) loading = false;
    }
  }
  onMount(() => {
    environmentId =
      environments.find((e) => e.id === initialEnvironment)?.id ?? environments[0]?.id ?? '';
    if (environmentId) void load();
    return () => {
      generation++;
    };
  });
  async function accept() {
    if (!listing || loading || saving) return;
    saving = true;
    try {
      await choose({ computerId, environmentId, path: listing.path });
      close();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

<ConnectionDialog title="Choose a folder" busy={saving} {close}>
  <p class="folder-computer">{computerName}</p>
  <div class="fleet-field">
    <span>Environment</span><ChoicePicker
      label="Folder environment"
      value={environmentId}
      options={environments.map((e) => ({ id: e.id, name: e.name }))}
      field
      disabled={saving || !environments.length}
      onchange={(id) => {
        environmentId = id;
        void load();
      }}
    />
  </div>
  <form
    class="folder-navigation"
    onsubmit={(e) => {
      e.preventDefault();
      void load(path);
    }}
  >
    <label
      >Folder path<input
        aria-label="Folder path"
        bind:value={path}
        placeholder="Enter an absolute path"
        disabled={saving}
      /></label
    >
    <button class="secondary" disabled={loading || saving || !environmentId} type="submit"
      >Go</button
    >
  </form>
  <div class="folder-navigation-actions">
    <button
      class="text-button"
      disabled={loading || saving || !listing?.parent}
      onclick={() => void load(listing?.parent ?? '')}><ArrowUp size={14} />Parent folder</button
    >
    <button
      class="text-button"
      disabled={loading || saving || !environmentId}
      onclick={() => void load()}><House size={14} />Home</button
    >
  </div>
  <div class="folder-entries" aria-label="Folders" aria-busy={loading}>
    {#if loading}<p><RefreshCw size={15} class="spinning" />Loading folders…</p>
    {:else if error}<p role="alert">{error}</p>
    {:else if listing}{#each listing.entries as entry}<button
          disabled={saving || loading}
          onclick={() => void load(entry.path)}
          ><Folder size={17} /><span>{entry.name}</span><ChevronRight size={14} /></button
        >{:else}<p>No subfolders. You can select this folder.</p>{/each}{/if}
  </div>
  {#if listing?.truncated}<p>
      Showing the first 1,000 folders. Enter a path to open another folder.
    </p>{/if}
  <p>
    The CLI starts in this folder using its environment’s CLIs. Conversation tool restrictions stay
    in place.
  </p>
  <div class="dialog-actions">
    <button class="secondary" disabled={saving} onclick={close}>Cancel</button><button
      class="primary"
      disabled={!listing || loading || saving || path !== listing.path}
      onclick={() => void accept()}>{saving ? 'Selecting…' : 'Use this folder'}</button
    >
  </div>
</ConnectionDialog>

<style>
  .folder-computer {
    margin-top: -10px;
  }
  .folder-navigation {
    display: flex;
    align-items: end;
    gap: 10px;
    margin: 18px 0 12px;
  }
  .folder-navigation label {
    flex: 1;
  }
  .folder-navigation-actions {
    display: flex;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .folder-entries {
    height: min(280px, 32vh);
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 6px;
  }
  .folder-entries button {
    width: 100%;
    gap: 10px;
    padding: 11px;
    text-align: left;
    border-radius: 6px;
  }
  .folder-entries button:hover {
    background: #293323;
  }
  .folder-entries button span {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .folder-entries p {
    display: flex;
    gap: 8px;
    padding: 12px;
  }
</style>
