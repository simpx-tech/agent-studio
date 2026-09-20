<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    X,
    RefreshCw,
    Search,
    FileText,
    Sparkles,
    Brain,
    Plug,
    Webhook,
    Copy,
    Check,
  } from '@lucide/svelte';
  import { providers, type ChatSettings, type ChatLocation } from '$lib/domain';
  import { contextCache, managePlugins } from '$lib/transport';
  import PluginManagement from './PluginManagement.svelte';
  import NativeInstructions from './NativeInstructions.svelte';
  import McpManagement from './McpManagement.svelte';
  import {
    contextKey,
    contextStatuses,
    type ContextSnapshot,
    type ContextKind,
  } from '$lib/context';

  let {
    conversationId,
    forked = false,
    settings,
    location,
    modelName,
    accountName,
    computerName,
    close,
    useSkill,
    running = false,
  }: {
    conversationId?: string;
    forked?: boolean;
    settings: ChatSettings;
    location?: ChatLocation;
    modelName: string;
    accountName: string;
    computerName: string;
    close: () => void;
    useSkill: (name: string, path: string) => void;
    running?: boolean;
  } = $props();
  let snapshot = $state<ContextSnapshot>();
  let error = $state('');
  let loading = $state(false);
  let category = $state<ContextKind | 'native' | 'plugins'>('instructions');
  let changingSkill = $state('');
  let search = $state('');
  let refresh = $state(0);
  let copied = $state('');
  let closeButton: HTMLButtonElement;
  const selectionKey = $derived(contextKey({ ...settings, conversationId, forked }, location));
  const categories = [
    { id: 'instructions', name: 'Instructions', icon: FileText },
    { id: 'native', name: 'Native prompt', icon: FileText },
    { id: 'skills', name: 'Skills', icon: Sparkles },
    { id: 'plugins', name: 'Plugins', icon: Plug },
    { id: 'memories', name: 'Memories', icon: Brain },
    { id: 'mcps', name: 'MCPs', icon: Plug },
    { id: 'hooks', name: 'Hooks', icon: Webhook },
  ] as const;
  const entries = $derived((snapshot?.entries ?? []).filter((e) => e.kind === category));
  const filtered = $derived(
    entries.filter((e) =>
      `${e.name} ${e.path} ${e.scope} ${contextStatuses[e.status]} ${e.detail}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
  );
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.focus();
    const changed = () => refresh++;
    window.addEventListener('studio-skills-changed', changed);
    return () => {
      window.removeEventListener('studio-skills-changed', changed);
      if (previous?.isConnected) previous.focus();
    };
  });
  $effect(() => {
    selectionKey;
    refresh;
    let cancelled = false;
    untrack(() => {
      const selected = {
        provider: settings.provider,
        model: settings.model,
        connectionId: settings.connectionId,
        conversationId,
        forked,
      };
      const folder = location;
      snapshot = contextCache.peek(selected, folder);
      error = '';
      loading = true;
      contextCache
        .refresh(selected, folder)
        .then((value) => {
          if (!cancelled) snapshot = value;
        })
        .catch((e) => {
          if (!cancelled) error = String(e);
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    });
    return () => {
      cancelled = true;
    };
  });
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      copied = path;
    } catch {
      error = 'Could not copy the path. Select the path text to copy it manually.';
    }
  }
  async function toggleSkill(path: string, enabled: boolean) {
    changingSkill = path;
    error = '';
    const selected = selectionKey;
    try {
      await managePlugins(settings, conversationId, location, { kind: 'skill', path, enabled });
    } catch (e) {
      if (selectionKey === selected) error = String(e);
    } finally {
      if (selectionKey === selected) changingSkill = '';
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div
    class="modal context-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="context-title"
    tabindex="-1"
  >
    <header>
      <div>
        <span class="eyebrow">{providers[settings.provider].name} · {modelName}</span>
        <h2 id="context-title">Model context</h2>
      </div>
      <button
        bind:this={closeButton}
        class="icon-button"
        onclick={close}
        aria-label="Close model context"><X size={20} /></button
      >
    </header>
    <div class="context-body">
      <p class="context-intro">
        {#if category === 'native'}
          Recorded CLI instructions for this conversation’s selected account and computer.
        {:else}
          Instructions and resources for this model’s selected account, folder, and conversation.
        {/if}
      </p>
      <div class="context-location">
        <strong>{computerName} · {accountName}</strong>
        <span>{snapshot?.execution ?? providers[settings.provider].name}</span>
        <code>{snapshot?.folder ?? location?.path ?? 'Isolated conversation folder'}</code>
        {#if snapshot}<span class="context-profile">Profile: <code>{snapshot.profile}</code></span
          >{/if}
      </div>
      {#if settings.instructions.trim()}
        <details class="context-custom">
          <summary>Conversation instructions <span>Included with the next message</span></summary>
          <pre>{settings.instructions}</pre>
        </details>
      {/if}
      <div class="context-categories" aria-label="Context categories">
        {#each categories as tab}
          <button
            class:active={category === tab.id}
            aria-pressed={category === tab.id}
            onclick={() => {
              category = tab.id;
              search = '';
            }}
          >
            <tab.icon size={15} />{tab.name}{#if tab.id !== 'native' && tab.id !== 'plugins'}<span
                >{snapshot ? snapshot.entries.filter((e) => e.kind === tab.id).length : '—'}</span
              >{/if}
          </button>
        {/each}
      </div>
      {#if category !== 'native'}<div class="context-search">
          <Search size={15} aria-hidden="true" /><input
            aria-label="Filter context sources"
            placeholder="Filter by name, path, or scope…"
            bind:value={search}
          />
          <button
            class="icon-button"
            disabled={loading}
            onclick={() => refresh++}
            aria-label="Refresh model context"
            title="Refresh model context"
            ><RefreshCw size={15} class={loading ? 'spinning' : ''} /></button
          >
        </div>{/if}
      {#if error && category !== 'native'}<p class="error-banner" role="alert">{error}</p>{/if}
      <div class="context-entries" aria-busy={category !== 'native' && loading}>
        {#if category === 'native'}
          <NativeInstructions {conversationId} {settings} />
        {:else if category === 'plugins'}
          {#key selectionKey}<PluginManagement
              {settings}
              {conversationId}
              {location}
              {running}
              {search}
              changed={() => refresh++}
            />{/key}
        {:else if category === 'mcps'}
          <McpManagement
            {settings}
            {conversationId}
            {location}
            {entries}
            {search}
            {running}
            changed={() => refresh++}
          />
        {:else}
          {#if category === 'memories'}
            <p class="context-category-help">
              Global memory entrypoints and sources for this project or folder. Topic files are read
              when relevant to the task.
            </p>
          {/if}
          {#if loading && !snapshot}<p class="context-empty" role="status">
              Inspecting the selected CLI profile…
            </p>
          {:else if snapshot && !filtered.length}<p class="context-empty">
              {search
                ? 'No sources match this filter.'
                : category === 'hooks'
                  ? settings.provider === 'gemini'
                    ? 'Hook discovery is unavailable for this agent.'
                    : 'No hooks were reported or discovered. Check the inspection notes for availability.'
                  : `No ${category} were reported or found in the inspected locations.`}
            </p>
          {:else}
            {#each filtered as entry (entry.kind + entry.path + entry.name)}
              <article class="context-entry">
                <div class="context-entry-title">
                  <strong>{entry.name}</strong><span class="context-scope">{entry.scope}</span><span
                    class="context-status"
                    class:reported={entry.status === 'reported'}
                    >{contextStatuses[entry.status]}</span
                  >
                </div>
                {#if entry.kind !== 'mcps'}<div class="context-path">
                    <code>{entry.path}</code><button
                      class="icon-button"
                      aria-label={`Copy path for ${entry.name}`}
                      title="Copy path"
                      onclick={() => copyPath(entry.path)}
                      >{#if copied === entry.path}<Check size={14} />{:else}<Copy
                          size={14}
                        />{/if}</button
                    >
                  </div>{/if}
                <p>{entry.detail}</p>
                {#if entry.kind === 'skills' && settings.provider !== 'gemini'}
                  {#if settings.provider === 'codex' && ['reported', 'disabled'].includes(entry.status)}
                    <button
                      class="text-button"
                      disabled={running || loading || !!changingSkill}
                      aria-label={`${entry.status === 'disabled' ? 'Enable' : 'Disable'} skill ${entry.name}`}
                      onclick={() => toggleSkill(entry.path, entry.status === 'disabled')}
                    >
                      {changingSkill === entry.path
                        ? 'Saving…'
                        : entry.status === 'disabled'
                          ? 'Enable'
                          : 'Disable'}
                    </button>
                  {/if}
                  <button
                    class="text-button"
                    disabled={entry.status === 'disabled'}
                    aria-label={`Use skill ${entry.name}`}
                    title={entry.status === 'disabled'
                      ? 'Disabled in the selected CLI profile'
                      : 'Add this skill to your next message'}
                    onclick={() => useSkill(entry.name, entry.path)}
                    ><Sparkles size={13} />Use in next message</button
                  >
                {/if}
              </article>
            {/each}
          {/if}
        {/if}
      </div>
      {#if snapshot && category !== 'native'}
        <div class="context-notes">
          {#if snapshot.truncated}<p role="status">
              The inventory reached its size limit. Additional sources may exist.
            </p>{/if}
          {#each snapshot.notes as note}<p>{note}</p>{/each}
        </div>
      {/if}
    </div>
    {#if snapshot || category === 'native'}
      <footer>
        {#if category === 'native'}<span>Native session inspection</span>{:else if snapshot}
          <span
            >Checked {new Date(snapshot.checkedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })} · Context inventory
            <span role="status"
              >{loading ? '· Updating…' : error ? '· Showing last saved result' : ''}</span
            ></span
          >{/if}<button class="secondary" onclick={close}>Done</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .context-modal {
    width: min(820px, 100%);
    height: min(800px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 26px;
  }
  .context-modal > header,
  .context-modal > footer {
    flex-shrink: 0;
  }
  .context-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .context-body > * {
    flex-shrink: 0;
  }
  .context-modal header {
    margin-bottom: 14px;
  }
  .context-intro {
    font-size: 12px;
    line-height: 1.7;
    color: #a9ba9b;
    margin: 0 0 16px;
  }
  .context-location {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 12px;
    font-size: 11px;
    padding: 13px 15px;
    background: #15200f;
    border: 1px solid #35472b;
    border-radius: 8px;
  }
  .context-location > strong {
    color: #d5dfca;
  }
  .context-location > span {
    color: #97af80;
  }
  .context-location > code,
  .context-profile {
    flex-basis: 100%;
  }
  code {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-size: 10px;
    color: #a4b697;
  }
  .context-custom {
    margin-top: 15px;
    font-size: 11px;
  }
  summary {
    cursor: pointer;
  }
  summary span {
    color: #91a680;
    margin-left: 10px;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    line-height: 1.7;
    padding: 12px;
    background: #15200f;
    max-height: 180px;
    overflow: auto;
  }
  .context-categories {
    display: flex;
    flex-wrap: wrap;
    margin-top: 20px;
    gap: 8px;
    border-bottom: 1px solid #35472b;
  }
  .context-categories button {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 11px 12px;
    font-size: 12px;
    color: #96ab86;
    border-bottom: 2px solid transparent;
  }
  .context-categories button.active {
    color: #d9e8cb;
    border-bottom-color: #a8c68d;
  }
  .context-categories button span {
    color: #839a71;
    font-size: 10px;
  }
  .context-search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 15px 0 5px;
    color: #94ab81;
  }
  .context-search input {
    width: 100%;
    padding: 9px 10px;
  }
  .context-body > .context-entries {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
  }
  .context-entry {
    border-bottom: 1px solid #334329;
    padding: 13px 0;
  }
  .context-entry-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .context-entry-title strong {
    overflow-wrap: anywhere;
  }
  .context-scope {
    font-size: 10px;
    color: #8fa47e;
  }
  .context-status {
    margin-left: auto;
    font-size: 10px;
    color: #a6b49a;
  }
  .context-status.reported {
    color: #afd88e;
  }
  .context-path {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 5px;
  }
  .context-path code {
    flex: 1;
  }
  .context-path button {
    flex-shrink: 0;
  }
  .context-entry p {
    margin: 4px 25px 0 0;
    color: #8ba179;
    font-size: 10px;
    line-height: 1.6;
  }
  .context-empty {
    padding: 30px 5px;
    color: #9ab187;
    font-size: 12px;
    line-height: 1.7;
  }
  .context-category-help {
    color: #9ab187;
    font-size: 11px;
    line-height: 1.6;
    margin: 10px 0;
  }
  .context-notes {
    margin-top: 15px;
  }
  .context-notes p {
    color: #9caf8b;
    font-size: 10px;
    line-height: 1.7;
    margin: 5px 0;
  }
  .context-modal footer {
    align-items: center;
    padding-top: 13px;
    margin-top: 14px;
  }
  footer span {
    margin-right: auto;
    font-size: 10px;
    color: #8ba179;
  }
  @media (max-width: 700px), (max-height: 700px) {
    .context-body {
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .context-body > .context-entries {
      flex: none;
      overflow: visible;
    }
  }
  @media (max-width: 700px) {
    .context-modal {
      padding: 18px;
    }
    .context-categories {
      gap: 0;
    }
    .context-categories button {
      padding: 10px 8px;
    }
  }
  @media (max-width: 360px) {
    .context-categories button {
      flex: 1;
      gap: 4px;
      padding: 10px 4px;
      font-size: 11px;
    }
  }
</style>
