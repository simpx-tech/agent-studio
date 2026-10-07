<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    CircleAlert,
    LayoutDashboard,
    LoaderCircle,
    MessageSquare,
    RotateCcw,
    ShieldAlert,
    ShieldCheck,
    Trash2,
  } from '@lucide/svelte';
  import {
    allowScreen,
    artifactPreviewUrl,
    deleteScreen,
    loadScreenData,
    readScreen,
    revokeScreen,
    runScreenAction,
    saveScreenData,
  } from '$lib/transport';
  import {
    screenCall,
    screenFolderName,
    screenReply,
    type ScreenCall,
    type ScreenDetail,
    type ScreenSummary,
  } from '$lib/screens';
  import { screenPreview } from '$lib/screen-preview';
  import { appearance } from '$lib/appearance.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ScreenActions from './ScreenActions.svelte';
  let {
    environmentId,
    id,
    summary,
    computerName,
    online,
    openConversation,
    chat,
    changed,
    deleted,
  }: {
    /** The environment whose computer keeps the screen, which routes its requests. */
    environmentId: string;
    id: string;
    /** What the Screens list knows of it, shown while it opens. */
    summary?: ScreenSummary;
    computerName: string;
    online: boolean;
    /** Opens the chat that created the screen, when it is in this workspace. */
    openConversation?: () => void;
    /** `studio.chat`: a new conversation in the screen's folder with this text as its draft. */
    chat: (text: string, screen: ScreenDetail) => void;
    /** The screen as its computer last reported it. */
    changed?: (screen: ScreenDetail) => void;
    deleted: () => void;
  } = $props();
  /** Answers one frame waits for at once; more is a page calling in a loop. */
  const maxWaiting = 8;
  const notAllowed =
    'The user has not allowed this screen’s actions yet. They can review and allow them above the screen.';
  let detail = $state<ScreenDetail>();
  let loading = $state(false);
  let error = $state('');
  let url = $state('');
  let restart = $state(0);
  let frame = $state<HTMLIFrameElement>();
  // The frame shown now; calls of an earlier one are never answered.
  let token = '';
  let waiting = 0;
  let serial = 0;
  let running = $state<Record<number, string>>({});
  const runningNames = $derived([...new Set(Object.values(running))]);
  let reviewing = $state(false);
  let reviewBusy = $state(false);
  let reviewError = $state('');
  let confirmingDelete = $state(false);
  let deleting = $state(false);
  let deleteError = $state('');
  const title = $derived(detail?.title ?? summary?.title ?? 'Screen');
  const folder = $derived(screenFolderName(detail ?? summary ?? { project: '', folder: '' }));
  const pending = $derived(!!detail?.actions.length && !detail.allowed);
  const message = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '');

  async function load() {
    if (loading) return;
    loading = true;
    error = '';
    try {
      const next = await readScreen(environmentId, id);
      detail = next;
      changed?.(next);
    } catch (e) {
      error = message(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void artifactPreviewUrl()
      .then((value) => (url = value))
      .catch(() => (error = 'This window cannot show screens.'));
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      token = '';
    };
  });
  // Opens once its computer is reachable, and again when a chat saved a newer revision.
  $effect(() => {
    if (!online) return;
    const known = summary?.revision ?? 0;
    untrack(() => {
      if (!detail || known > detail.revision) void load();
    });
  });

  function initialize(event: Event) {
    const target = event.currentTarget as HTMLIFrameElement;
    if (target.dataset.initialized || !detail) return;
    target.dataset.initialized = 'true';
    token = crypto.randomUUID();
    waiting = 0;
    running = {};
    target.contentWindow?.postMessage(
      screenPreview(
        detail.html,
        token,
        { id: detail.id, title: detail.title },
        appearance.resolved,
      ),
      '*',
    );
  }
  function receive(event: MessageEvent) {
    if (!frame || !token || event.source !== frame.contentWindow) return;
    const call = screenCall(event.data, token);
    if (!call) return;
    const callToken = token;
    const target = frame.contentWindow;
    const reply = (result: { value: unknown } | { error: string }) => {
      // A reloaded or closed frame no longer waits for this answer.
      if (token !== callToken || frame?.contentWindow !== target) return;
      target?.postMessage(screenReply(callToken, call.id, result), '*');
    };
    if (waiting >= maxWaiting) {
      reply({ error: `This screen already waits for ${maxWaiting} answers. Wait for them first.` });
      return;
    }
    waiting++;
    void answer(call)
      .then(
        (value) => reply({ value }),
        (e) => reply({ error: message(e) }),
      )
      .finally(() => {
        if (token === callToken) waiting--;
      });
  }
  async function answer(call: ScreenCall): Promise<unknown> {
    if (call.method === 'run') {
      // The computer that keeps the screen checks again; this spares it a request.
      if (!detail?.allowed) throw new Error(notAllowed);
      const key = ++serial;
      running[key] = call.action;
      try {
        return await runScreenAction(environmentId, id, call.action, call.params);
      } finally {
        delete running[key];
      }
    }
    if (call.method === 'load') return (await loadScreenData(environmentId, id))[call.key] ?? null;
    if (call.method === 'save') {
      await saveScreenData(environmentId, id, call.key, call.value);
      return null;
    }
    // A page may open a chat only as the reader works in it, never by itself.
    if (document.activeElement !== frame || !detail)
      throw new Error('studio.chat works right after the user clicks or types in the screen.');
    chat(call.text, detail);
    return null;
  }

  function reload() {
    void load().then(() => restart++);
  }
  async function review(allowing: boolean) {
    if (!detail || reviewBusy) return;
    reviewBusy = true;
    reviewError = '';
    try {
      const next = allowing
        ? await allowScreen(environmentId, id, detail.digest)
        : await revokeScreen(environmentId, id);
      detail = next;
      changed?.(next);
      reviewing = false;
      // The page starts again, so what it ran on opening runs now that it may.
      if (allowing) restart++;
    } catch (e) {
      reviewError = message(e);
      // Its actions changed meanwhile: show the ones there are now.
      if (allowing) void load();
    } finally {
      reviewBusy = false;
    }
  }
  async function remove() {
    if (deleting) return;
    deleting = true;
    deleteError = '';
    try {
      await deleteScreen(environmentId, id);
      confirmingDelete = false;
      deleted();
    } catch (e) {
      deleteError = message(e);
    } finally {
      deleting = false;
    }
  }
</script>

<section class="screen-page" aria-label={title}>
  <header class="screen-toolbar">
    <div class="screen-heading">
      <LayoutDashboard size={17} aria-hidden="true" />
      <div>
        <h1>{title}</h1>
        <p title={detail?.folder ?? summary?.folder}>
          {computerName} · {folder}{#if (detail ?? summary)?.description}<span
              class="screen-description">{` · ${(detail ?? summary)?.description}`}</span
            >{/if}
        </p>
      </div>
    </div>
    <div class="screen-tools">
      {#if runningNames.length}<span class="screen-running" role="status"
          ><LoaderCircle size={13} class="spinning" aria-hidden="true" />Running {runningNames.join(
            ', ',
          )}</span
        >{/if}
      {#if detail?.actions.length}<button
          class="icon-button"
          class:screen-pending={pending}
          title={pending ? 'Review and allow its actions' : 'Its actions'}
          aria-label="Review this screen’s actions"
          onclick={() => {
            reviewError = '';
            reviewing = true;
          }}
          >{#if pending}<ShieldAlert size={16} />{:else}<ShieldCheck size={16} />{/if}</button
        >{/if}
      {#if openConversation}<button
          class="icon-button"
          title="Open the chat that made it"
          aria-label="Open the chat that made this screen"
          onclick={openConversation}><MessageSquare size={16} /></button
        >{/if}
      <button
        class="icon-button"
        title="Reload"
        aria-label="Reload this screen"
        disabled={!online || loading}
        onclick={reload}><RotateCcw size={16} /></button
      >
      <button
        class="icon-button"
        title="Delete screen"
        aria-label="Delete this screen"
        disabled={!online || !detail}
        onclick={() => {
          deleteError = '';
          confirmingDelete = true;
        }}><Trash2 size={16} /></button
      >
    </div>
  </header>
  {#if !online}<div class="setup-hint neutral" role="status">
      <CircleAlert size={15} aria-hidden="true" /><span>{computerName} is offline.</span>
    </div>
  {:else if pending && detail}<div class="setup-hint" role="status">
      <ShieldAlert size={15} aria-hidden="true" /><span
        >This screen runs {detail.actions.length === 1
          ? 'an action'
          : `${detail.actions.length} actions`} on {computerName}. Review before allowing.</span
      ><button
        class="text-button"
        onclick={() => {
          reviewError = '';
          reviewing = true;
        }}>Review actions</button
      >
    </div>{/if}
  {#if error}<div class="error-banner screen-error" role="alert">
      <CircleAlert size={15} aria-hidden="true" />{error}
    </div>{/if}
  <div class="screen-frame">
    {#if detail && url}{#key `${detail.revision}:${restart}:${appearance.resolved}`}<iframe
          bind:this={frame}
          title={`${title} screen`}
          src={url}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          onload={initialize}
        ></iframe>{/key}{:else if loading || (online && !error)}<p
        class="screen-status"
        role="status"
      >
        Opening screen…
      </p>{/if}
  </div>
</section>
{#if reviewing && detail}<ScreenActions
    screen={detail}
    {computerName}
    busy={reviewBusy}
    error={reviewError}
    allow={() => void review(true)}
    revoke={() => void review(false)}
    close={() => (reviewing = false)}
  />{/if}
{#if confirmingDelete && detail}<ConnectionDialog
    title="Delete screen"
    busy={deleting}
    close={() => (confirmingDelete = false)}
  >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void remove();
      }}
    >
      <p>
        Delete <strong>{detail.title}</strong> from {computerName}?
      </p>
      {#if deleteError}<div class="error-banner" role="alert">{deleteError}</div>{/if}
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary"
          disabled={deleting}
          onclick={() => (confirmingDelete = false)}>Cancel</button
        ><button type="submit" class="danger" disabled={deleting}
          >{deleting ? 'Deleting…' : 'Delete screen'}</button
        >
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .screen-page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 12px 20px 16px;
    gap: 10px;
  }
  .screen-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .screen-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .screen-heading > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  .screen-heading div {
    min-width: 0;
  }
  .screen-heading h1 {
    margin: 0;
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-tight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-heading p {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-tools {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .screen-running {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: 8px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-tools :global(.screen-pending) {
    color: var(--warning);
  }
  .setup-hint {
    margin-bottom: 0;
  }
  .screen-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .screen-frame {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    overflow: hidden;
  }
  .screen-frame iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }
  .screen-status {
    margin: 0;
    padding: 20px 24px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  @media (max-width: 700px) {
    .screen-page {
      padding: 8px 10px 10px;
    }
    .screen-description {
      display: none;
    }
    .screen-running {
      display: none;
    }
    .screen-tools .icon-button {
      width: 40px;
      height: 40px;
    }
  }
</style>
