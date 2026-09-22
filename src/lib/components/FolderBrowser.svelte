<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    ArrowUp,
    Check,
    ChevronRight,
    Clock,
    Folder,
    FolderGit2,
    FolderOpen,
    HardDrive,
    House,
    Pencil,
    RefreshCw,
    Search,
    X,
  } from '@lucide/svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import type { Environment } from '$lib/fleet';
  import type { ChatLocation } from '$lib/domain';
  import type { FolderListing } from '$lib/transport';
  import {
    compactPath,
    describeFolders,
    expandHome,
    filterFolders,
    isAbsolutePath,
    pathSegments,
    type FolderPlace,
  } from '$lib/folders';
  import { folderName } from '$lib/locations';
  let {
    computerId,
    computerName,
    environments,
    executionEnvironmentId,
    initialEnvironment,
    initialLocation,
    recent = [],
    browse,
    choose,
    close,
  }: {
    computerId: string;
    computerName: string;
    environments: Environment[];
    executionEnvironmentId?: string;
    initialEnvironment?: string;
    // The browser opens at the currently selected folder when it belongs to the same environment.
    initialLocation?: ChatLocation;
    // Remembered folders on this computer; shown for the selected environment only.
    recent?: ChatLocation[];
    browse: (environmentId: string, path?: string) => Promise<FolderListing>;
    choose: (location: ChatLocation) => Promise<void>;
    close: () => void;
  } = $props();
  const HIDDEN_KEY = 'studio-folder-browser-hidden';
  let environmentId = $state('');
  // The requested path drives the breadcrumbs even when it failed to open.
  let path = $state('');
  let listing = $state<FolderListing>();
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let editing = $state(false);
  let draftPath = $state('');
  let query = $state('');
  let showHidden = $state(false);
  let placesByEnvironment = $state<Record<string, FolderPlace[]>>({});
  let pathInput = $state<HTMLInputElement>();
  let filterInput = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();
  let root = $state<HTMLDivElement>();
  let generation = 0;

  const places = $derived(placesByEnvironment[environmentId] ?? []);
  const home = $derived(places.find((place) => place.kind === 'home')?.path);
  const quickPlaces = $derived(places.filter((place) => place.kind !== 'home'));
  const segments = $derived(pathSegments(path));
  const visible = $derived(listing ? filterFolders(listing.entries, { query, showHidden }) : []);
  const jumpTarget = $derived.by(() => {
    const expanded = expandHome(query, home);
    return isAbsolutePath(expanded) ? expanded : '';
  });
  const recentHere = $derived(
    [
      ...new Map(
        recent
          .filter(
            (location) =>
              location.path &&
              location.computerId === computerId &&
              location.environmentId === environmentId,
          )
          .map((location) => [location.path, location]),
      ).values(),
    ].slice(0, 8),
  );
  const environmentLabel = $derived(
    environments.find((e) => e.id === environmentId)?.name ?? 'the selected environment',
  );
  const busy = $derived(loading || saving);
  const canUse = $derived(!!listing && !busy && path === listing.path);

  function coarsePointer() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  }
  async function load(next = '') {
    const token = ++generation;
    const environment = environmentId;
    loading = true;
    error = '';
    path = next;
    try {
      const result = await browse(environment, next);
      if (token !== generation) return;
      listing = result;
      path = result.path;
      if (result.places)
        placesByEnvironment = { ...placesByEnvironment, [environment]: result.places };
      editing = false;
      query = '';
      await tick();
      // Typing right after opening a folder filters it; touch keyboards stay closed.
      if (!coarsePointer()) filterInput?.focus({ preventScroll: true });
    } catch (e) {
      if (token !== generation) return;
      listing = undefined;
      error = String(e);
      if (editing) pathInput?.focus();
    } finally {
      if (token === generation) loading = false;
    }
  }
  onMount(() => {
    try {
      showHidden = localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      showHidden = false;
    }
    environmentId =
      environments.find((e) => e.id === initialEnvironment)?.id ?? environments[0]?.id ?? '';
    const start =
      initialLocation &&
      initialLocation.computerId === computerId &&
      initialLocation.environmentId === environmentId
        ? initialLocation.path
        : '';
    if (environmentId) void load(start);
    return () => {
      generation++;
    };
  });
  function selectEnvironment(id: string) {
    if (id === environmentId) return;
    environmentId = id;
    listing = undefined;
    query = '';
    editing = false;
    void load();
  }
  function rememberHidden(value: boolean) {
    showHidden = value;
    try {
      localStorage.setItem(HIDDEN_KEY, value ? '1' : '0');
    } catch {
      // Per-viewer convenience only.
    }
  }
  async function startEditing() {
    if (busy) return;
    draftPath = path;
    editing = true;
    await tick();
    pathInput?.focus();
    pathInput?.select();
  }
  function submitPath() {
    const target = expandHome(draftPath, home);
    if (!target) return;
    void load(target);
  }
  async function accept(target?: string) {
    const selected = target ?? listing?.path;
    if (!selected || busy || (!target && !canUse)) return;
    saving = true;
    error = '';
    try {
      await choose({
        computerId,
        environmentId,
        path: selected,
        ...(executionEnvironmentId && executionEnvironmentId !== environmentId
          ? { executionEnvironmentId }
          : {}),
      });
      close();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
  function rows() {
    return [...(list?.querySelectorAll<HTMLButtonElement>('.folder-open') ?? [])];
  }
  function filterKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (jumpTarget) void load(jumpTarget);
      else if (query.trim() && visible[0]) void load(visible[0].path);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      query = '';
    }
  }
  function listKeydown(event: KeyboardEvent) {
    const buttons = rows();
    const index = buttons.findIndex((button) =>
      button.closest('li')?.contains(document.activeElement),
    );
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowUp' && index <= 0) {
        filterInput?.focus();
        return;
      }
      buttons[Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (listing?.parent && !busy) void load(listing.parent);
    }
  }
  function browserKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      void startEditing();
    } else if (event.altKey && event.key === 'ArrowUp' && listing?.parent && !busy) {
      event.preventDefault();
      void load(listing.parent);
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (root?.contains(event.target as Node)) browserKeydown(event);
  }}
/>

<ConnectionDialog title="Choose a folder" busy={saving} wide {close}>
  <div class="folder-browser" bind:this={root}>
    <div class="browser-scope">
      <span
        class="browser-computer"
        title={`Uses the CLI and account on ${computerName}. Choosing a folder does not change the computer that runs the agent.`}
        >{computerName}</span
      >
      <ChoicePicker
        label="Folder environment"
        value={environmentId}
        options={environments.map((e) => ({ id: e.id, name: e.name }))}
        disabled={saving || !environments.length}
        onchange={selectEnvironment}
      >
        {#snippet icon()}<HardDrive size={14} />{/snippet}
      </ChoicePicker>
    </div>
    <div class="browser-body">
      <aside class="browser-places" aria-label="Quick access">
        {#if recentHere.length}
          <div class="places-heading"><Clock size={11} aria-hidden="true" />Recent</div>
          <div class="places-group">
            {#each recentHere as location (location.path)}
              <button
                type="button"
                class="place"
                class:active={listing?.path === location.path}
                title={location.path}
                disabled={busy}
                onclick={() => void load(location.path)}
                ><Folder size={14} aria-hidden="true" /><span>{folderName(location.path)}</span
                ></button
              >
            {/each}
          </div>
        {/if}
        <div class="places-heading">Places</div>
        <div class="places-group">
          <button
            type="button"
            class="place"
            class:active={!!home && listing?.path === home}
            title={home ?? 'Home folder'}
            disabled={busy || !environmentId}
            onclick={() => void load()}
            ><House size={14} aria-hidden="true" /><span>Home</span></button
          >
          {#each quickPlaces as place (place.path)}
            <button
              type="button"
              class="place"
              class:active={listing?.path === place.path}
              title={place.path}
              disabled={busy}
              onclick={() => void load(place.path)}
            >
              {#if place.kind === 'folder'}<FolderOpen
                  size={14}
                  aria-hidden="true"
                />{:else}<HardDrive size={14} aria-hidden="true" />{/if}<span>{place.name}</span>
            </button>
          {/each}
        </div>
      </aside>
      <section class="browser-main" aria-label={`Folders in ${environmentLabel}`}>
        <div class="location-bar">
          <button
            type="button"
            class="icon-button"
            aria-label="Parent folder"
            title="Parent folder (Backspace in the list)"
            disabled={busy || !listing?.parent}
            onclick={() => void load(listing?.parent ?? '')}><ArrowUp size={15} /></button
          >
          {#if editing}
            <form
              class="path-form"
              onsubmit={(event) => {
                event.preventDefault();
                submitPath();
              }}
            >
              <input
                aria-label="Folder path"
                bind:value={draftPath}
                bind:this={pathInput}
                placeholder="Enter an absolute path"
                autocomplete="off"
                spellcheck="false"
                disabled={saving}
                onkeydown={(event) => {
                  if (event.key === 'Escape' && listing) {
                    event.preventDefault();
                    event.stopPropagation();
                    editing = false;
                  }
                }}
              />
              <button class="secondary" type="submit" disabled={busy || !draftPath.trim()}
                >Go</button
              >
              {#if listing}
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Stop editing path"
                  disabled={saving}
                  onclick={() => (editing = false)}><X size={15} /></button
                >
              {/if}
            </form>
          {:else}
            <nav class="breadcrumbs" aria-label="Current folder">
              {#each segments as segment, index (segment.path)}
                {#if index < segments.length - 1}
                  <button
                    type="button"
                    class="crumb"
                    title={segment.path}
                    disabled={busy}
                    onclick={() => void load(segment.path)}>{segment.name}</button
                  >
                  <ChevronRight size={12} class="crumb-separator" aria-hidden="true" />
                {:else}
                  <span class="crumb current" aria-current="location" title={segment.path}
                    >{segment.name}</span
                  >
                {/if}
              {:else}
                <span class="crumb current muted">{loading ? 'Opening…' : 'No folder'}</span>
              {/each}
            </nav>
            <button
              type="button"
              class="icon-button"
              aria-label="Edit path"
              title="Edit path (Ctrl+L)"
              disabled={busy}
              onclick={() => void startEditing()}><Pencil size={14} /></button
            >
          {/if}
          <button
            type="button"
            class="icon-button"
            aria-label="Refresh folders"
            title="Refresh"
            disabled={busy || !path}
            onclick={() => void load(path)}
            ><RefreshCw size={14} class={loading ? 'spinning' : undefined} /></button
          >
        </div>
        <div class="filter-bar">
          <label class="filter-field">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="Filter folders"
              placeholder="Filter folders, or paste a path and press Enter"
              bind:value={query}
              bind:this={filterInput}
              autocomplete="off"
              spellcheck="false"
              disabled={saving}
              onkeydown={filterKeydown}
            />
            {#if query}
              <button
                type="button"
                class="icon-button clear-filter"
                aria-label="Clear filter"
                onclick={() => {
                  query = '';
                  filterInput?.focus();
                }}><X size={13} /></button
              >
            {/if}
          </label>
          <label class="checkbox hidden-toggle"
            ><input
              type="checkbox"
              checked={showHidden}
              disabled={saving}
              onchange={(event) => rememberHidden(event.currentTarget.checked)}
            /><span>Show hidden</span></label
          >
        </div>
        {#if error}<p class="folder-error" role="alert">{error}</p>{/if}
        <div class="folder-entries" aria-busy={loading} class:dimmed={loading && !!listing}>
          {#if jumpTarget}
            <button
              type="button"
              class="jump-row"
              disabled={busy}
              onclick={() => void load(jumpTarget)}
              ><FolderOpen size={15} aria-hidden="true" /><span
                >Open <strong>{jumpTarget}</strong></span
              ><ChevronRight size={14} aria-hidden="true" /></button
            >
          {/if}
          {#if loading && !listing}
            <p class="folder-state"><RefreshCw size={15} class="spinning" />Loading folders…</p>
          {:else if listing}
            {#if visible.length}
              <ul class="folder-list" aria-label="Folders" bind:this={list}>
                {#each visible as entry (entry.path)}
                  <li class="folder-row" class:hidden-entry={entry.hidden}>
                    <button
                      type="button"
                      class="folder-open"
                      title={`${entry.path}${entry.repository ? ' · Git repository' : ''}`}
                      disabled={busy}
                      onclick={() => void load(entry.path)}
                      onkeydown={listKeydown}
                    >
                      {#if entry.repository}<FolderGit2
                          size={17}
                          class="folder-icon repository"
                          aria-hidden="true"
                        />{:else}<Folder size={17} class="folder-icon" aria-hidden="true" />{/if}
                      <span class="folder-name">{entry.name}</span>
                      {#if entry.repository}<span class="folder-badge" aria-hidden="true">git</span
                        >{/if}
                      <ChevronRight size={14} class="folder-chevron" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="folder-use"
                      aria-label={`Use ${entry.name}`}
                      title={`Use ${entry.name} without opening it`}
                      disabled={busy}
                      onclick={() => void accept(entry.path)}
                      onkeydown={listKeydown}><Check size={14} />Use</button
                    >
                  </li>
                {/each}
              </ul>
            {:else if query && !jumpTarget}
              <p class="folder-state">No folders match “{query.trim()}”.</p>
            {:else if !listing.entries.length}
              <p class="folder-state">No subfolders. You can use this folder.</p>
            {:else if !jumpTarget}
              <p class="folder-state">
                All {listing.entries.length} subfolders are hidden. Turn on Show hidden to see them.
              </p>
            {/if}
          {:else if !error}
            <p class="folder-state muted">Choose a place or enter a path to browse.</p>
          {/if}
        </div>
        <p class="folder-status">
          {#if listing}{describeFolders(listing.entries)}{#if listing.truncated}
              · Showing the first 1,000 folders; enter a path to open another folder.{/if}{/if}
        </p>
      </section>
    </div>
    <div class="dialog-actions">
      <span class="dialog-selection" title={listing?.path}>
        {#if listing}Use <strong>{compactPath(listing.path)}</strong> on {computerName}{/if}
      </span>
      <button class="secondary" disabled={saving} onclick={close}>Cancel</button><button
        class="primary"
        disabled={!canUse}
        onclick={() => void accept()}>{saving ? 'Selecting…' : 'Use this folder'}</button
      >
    </div>
  </div>
</ConnectionDialog>

<style>
  .folder-browser {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .browser-scope {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: -8px;
    font-size: 12px;
    color: var(--muted);
  }
  .browser-computer {
    font-weight: 500;
    color: var(--text);
  }
  .browser-scope::before {
    content: 'On';
  }
  .browser-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 188px minmax(0, 1fr);
    gap: 14px;
  }
  .browser-places {
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
    border-right: 1px solid var(--line);
  }
  .places-heading {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 6px 8px 5px;
    color: #7e8877;
    font-size: 9px;
    letter-spacing: 1.3px;
    text-transform: uppercase;
  }
  .places-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-bottom: 10px;
  }
  .place {
    width: 100%;
    justify-content: flex-start;
    gap: 8px;
    padding: 7px 9px;
    border: 1px solid transparent;
    border-radius: 7px;
    font-size: 12px;
    color: #c2cab9;
    text-align: left;
  }
  .place span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .place:not(:disabled):hover {
    background: #252c22;
  }
  .place.active {
    color: var(--green);
    background: #283420;
  }
  .browser-main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .location-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    padding: 2px 4px;
    border: 1px solid #34412a;
    border-radius: 9px;
    background: #141a12;
  }
  .breadcrumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    font-size: 12.5px;
  }
  .breadcrumbs :global(.crumb-separator) {
    color: #5f6b56;
    flex-shrink: 0;
  }
  .crumb {
    padding: 4px 6px;
    border-radius: 5px;
    font-size: 12.5px;
    color: #b8c1ae;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.crumb:not(:disabled):hover {
    background: #252c22;
    color: var(--text);
  }
  .crumb.current {
    color: var(--text);
    font-weight: 600;
  }
  .crumb.muted {
    color: var(--muted);
    font-weight: 400;
  }
  .path-form {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .path-form input {
    flex: 1;
    padding: 7px 10px;
    font-size: 12.5px;
    font-family: ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace;
  }
  .path-form .secondary {
    padding: 7px 12px;
  }
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .filter-field {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 10px;
    min-height: 34px;
    border: 1px solid #363d34;
    border-radius: 8px;
    background: #161916;
    color: #788372;
  }
  .filter-field:focus-within {
    border-color: #637a47;
  }
  .filter-field input {
    flex: 1;
    padding: 6px 0;
    background: transparent;
    border: 0;
    font-size: 12.5px;
    color: var(--text);
  }
  .filter-field input:focus-visible {
    outline: none;
  }
  .clear-filter {
    width: 24px;
    height: 24px;
  }
  .hidden-toggle {
    flex-direction: row;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: #b8c1ae;
    white-space: nowrap;
  }
  .folder-error {
    margin: 0;
    padding: 9px 12px;
    border-radius: 8px;
    background: #432c25;
    color: #ebc4b0;
    border: 1px solid #79523e;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .folder-entries {
    flex: 1;
    min-height: 140px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 5px;
    transition: opacity 0.16s;
  }
  .folder-entries.dimmed {
    opacity: 0.55;
  }
  .folder-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .folder-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
  }
  .folder-open {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 7px;
    text-align: left;
    font-size: 13px;
  }
  .folder-open:not(:disabled):hover,
  .folder-open:focus-visible {
    background: #293323;
  }
  .folder-open :global(.folder-icon) {
    flex-shrink: 0;
    color: #a3b08f;
  }
  .folder-open :global(.folder-icon.repository) {
    color: var(--green);
  }
  .folder-name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .folder-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid #465f2d;
    color: #b7c7a4;
    font-size: 9.5px;
    letter-spacing: 0.6px;
    text-transform: uppercase;
  }
  .folder-open :global(.folder-chevron) {
    flex-shrink: 0;
    color: #5f6b56;
  }
  .hidden-entry .folder-open {
    color: var(--muted);
  }
  .folder-use {
    flex-shrink: 0;
    gap: 5px;
    padding: 0 10px;
    border-radius: 7px;
    font-size: 11px;
    color: #b7c7a4;
    opacity: 0;
    transition:
      opacity 0.12s,
      background 0.16s;
  }
  .folder-row:hover .folder-use,
  .folder-row:focus-within .folder-use,
  .folder-use:focus-visible {
    opacity: 1;
  }
  .folder-use:not(:disabled):hover {
    background: #323e28;
    color: var(--green);
  }
  .jump-row {
    width: 100%;
    justify-content: flex-start;
    gap: 10px;
    margin-bottom: 4px;
    padding: 9px 10px;
    border: 1px dashed #465f2d;
    border-radius: 7px;
    text-align: left;
    font-size: 12.5px;
    color: #b7c7a4;
  }
  .jump-row span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .jump-row strong {
    color: var(--green);
    font-weight: 600;
  }
  .jump-row:not(:disabled):hover {
    background: #252c22;
  }
  .folder-state {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 14px 12px;
    color: var(--muted);
    font-size: 12px;
  }
  .folder-status {
    margin: 0;
    min-height: 16px;
    font-size: 11px;
    color: var(--muted);
  }
  .folder-browser :global(.dialog-actions) {
    flex-shrink: 0;
    align-items: center;
    margin-top: 2px;
  }
  .dialog-selection {
    flex: 1;
    min-width: 0;
    margin-right: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--muted);
  }
  .dialog-selection strong {
    color: var(--text);
    font-weight: 600;
  }
  @media (max-width: 720px) {
    .browser-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      gap: 10px;
    }
    .browser-places {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0 0 6px;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .places-heading {
      flex-shrink: 0;
      padding: 0 2px;
    }
    .places-group {
      flex-direction: row;
      gap: 4px;
      margin: 0 6px 0 0;
    }
    .place {
      width: auto;
      flex-shrink: 0;
      padding: 6px 9px;
      border-color: #34412a;
      border-radius: 999px;
    }
    .place span {
      max-width: 120px;
    }
    .filter-bar {
      flex-wrap: wrap;
      gap: 8px;
    }
    .folder-use {
      opacity: 1;
    }
    .dialog-selection {
      flex-basis: 100%;
      white-space: normal;
    }
    .folder-open {
      min-height: 44px;
    }
  }
</style>
