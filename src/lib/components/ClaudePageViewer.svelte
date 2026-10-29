<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { X, RotateCcw, ExternalLink, PanelRightOpen, Maximize2 } from '@lucide/svelte';
  import { panelRoom, showPanel, type PageView } from '$lib/side-panels';
  import { samePlace, slotCovered, type Place } from '$lib/claude-pages';
  import { appearance } from '$lib/appearance.svelte';
  import { onClaudePageEnded, openLink, showClaudePage } from '$lib/transport';
  import PanelResize from './PanelResize.svelte';
  // A claude.ai artifact inside the window (requested 2026-10-29): the modal or the side panel,
  // whose slot a WebView2 of its own covers (`src-tauri/src/claude_pages.rs`), signed in to the
  // claude.ai session of the account that published it.
  let {
    view,
    accountName,
    accountColor,
    takeFocus = true,
    changeMode,
    reload,
    close,
  }: {
    view: PageView;
    /** The account whose claude.ai session shows the artifact. */
    accountName?: string;
    accountColor?: string;
    /** False for a side panel shown again with its chat. */
    takeFocus?: boolean;
    changeMode: (mode: 'modal' | 'panel') => void;
    reload: () => void;
    close: () => void;
  } = $props();
  const mode = $derived(view.mode);
  let viewportWidth = $state(0);
  let workspaceWidth = $state(0);
  let panelWidth = $state<number>();
  const docked = $derived(mode === 'panel' && viewportWidth >= 1100 && workspaceWidth >= 780);
  let dialog = $state<HTMLDialogElement>();
  let slot = $state<HTMLDivElement>();
  let mounted = $state(false);
  let error = $state('');
  let shown = false;
  $effect(() => {
    if (!mounted || !dialog) return;
    const dock = docked;
    const box = dialog;
    untrack(() => showPanel(box, dock, '[aria-label="Close artifact"]', !shown && !takeFocus));
    shown = true;
    place();
  });

  // The pane follows its slot: shown over it while nothing of the page covers it, hidden
  // otherwise. Only changes are sent.
  const id = crypto.randomUUID();
  const dark = $derived(appearance.resolved === 'dark');
  let sent: { place?: Place; load: string; url: string; dark: boolean } | undefined;
  let frame = 0;
  function place() {
    if (!frame) frame = requestAnimationFrame(sync);
  }
  function sync() {
    frame = 0;
    if (!mounted || !slot) return;
    const rect = slot.getBoundingClientRect();
    const where = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    const covered = slotCovered(
      slot,
      where,
      { width: window.innerWidth, height: window.innerHeight },
      (x, y) => document.elementFromPoint(x, y),
    );
    const next = { place: covered ? undefined : where, load: view.load, url: view.page.url, dark };
    if (
      sent &&
      samePlace(sent.place, next.place) &&
      sent.load === next.load &&
      sent.url === next.url &&
      sent.dark === next.dark
    )
      return;
    sent = next;
    void showClaudePage({
      view: id,
      account: view.account,
      url: next.url,
      load: next.load,
      bounds: next.place,
      dark: next.dark,
    }).then(
      () => (error = ''),
      (e) => (error = String(e).replace(/^Error: /, '')),
    );
  }
  $effect(() => {
    // Another loading, artifact or theme.
    void [view.load, view.page.url, dark];
    untrack(place);
  });

  // Closing returns focus to what had it when the viewer opened; hidden with its chat, the
  // viewer leaves focus where the reader moved it.
  let dismissed = false;
  function dismiss() {
    dismissed = true;
    close();
  }
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    const workspace = dialog?.parentElement;
    const observer = new ResizeObserver(() => {
      if (workspace) workspaceWidth = panelRoom(workspace);
      place();
    });
    if (workspace) {
      workspaceWidth = panelRoom(workspace);
      observer.observe(workspace);
    }
    if (slot) observer.observe(slot);
    mounted = true;
    // What may open or close something over the slot: dialogs, menus and pickers open on a
    // press, a click or a key, and some place themselves a moment later.
    const later = () => {
      place();
      setTimeout(place, 150);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key.length > 1 || event.ctrlKey || event.altKey || event.metaKey) later();
    };
    const opened = new MutationObserver(later);
    opened.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    const events = ['pointerdown', 'click', 'contextmenu', 'toggle'] as const;
    for (const event of events) window.addEventListener(event, later, true);
    window.addEventListener('keydown', keys, true);
    window.addEventListener('resize', place);
    // Something the page opens or closes by itself shows within a second.
    const timer = setInterval(place, 1000);
    // A pane whose browser process ended is gone until Reload builds it again.
    const stopEnded = onClaudePageEnded((account) => {
      if (account === view.account.toLowerCase()) error = 'claude.ai stopped.';
    });
    return () => {
      stopEnded();
      observer.disconnect();
      opened.disconnect();
      clearInterval(timer);
      for (const event of events) window.removeEventListener(event, later, true);
      window.removeEventListener('keydown', keys, true);
      window.removeEventListener('resize', place);
      cancelAnimationFrame(frame);
      frame = 0;
      mounted = false;
      void showClaudePage({
        view: id,
        account: view.account,
        url: view.page.url,
        load: view.load,
        dark,
      }).catch(() => {});
      if (dismissed && focused?.isConnected) focused.focus();
    };
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} />
<!-- Docked, the gap between the chat and the panel resizes it. -->
{#if docked}<PanelResize
    gutter={12}
    availableWidth={workspaceWidth}
    onresize={(width) => (panelWidth = width)}
    storageKey="agent-studio.artifact-panel-width"
    label="Resize artifact panel"
    controls="claude-page-viewer"
  />{/if}
<dialog
  bind:this={dialog}
  id="claude-page-viewer"
  class="claude-page-viewer"
  style:--artifact-panel-width={panelWidth ? `${panelWidth}px` : undefined}
  class:side-panel={mode === 'panel'}
  class:docked
  aria-modal={docked ? undefined : 'true'}
  aria-labelledby="claude-page-title"
  onkeydown={(event) => {
    if (docked && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  }}
  oncancel={(event) => {
    event.preventDefault();
    dismiss();
  }}
>
  <header>
    <div>
      <span class="eyebrow"
        >{#if accountName}<span
            ><span class="account-dot" style:--account-color={accountColor} aria-hidden="true"
            ></span>{accountName}</span
          >{:else}claude.ai{/if}</span
      >
      <h2 id="claude-page-title">{view.page.title}</h2>
    </div>
    <div class="viewer-actions">
      <button class="icon-button" onclick={reload} aria-label="Reload" title="Reload"
        ><RotateCcw size={16} /></button
      >
      <button
        class="icon-button"
        onclick={() => void openLink(view.page.url).catch(() => {})}
        aria-label="Open in browser"
        title="Open in browser"><ExternalLink size={16} /></button
      >
      <button
        class="icon-button"
        onclick={() => changeMode(mode === 'panel' ? 'modal' : 'panel')}
        aria-label={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        title={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        >{#if mode === 'panel'}<Maximize2 size={17} />{:else}<PanelRightOpen
            size={17}
          />{/if}</button
      >
      <button class="icon-button" onclick={dismiss} aria-label="Close artifact"
        ><X size={19} /></button
      >
    </div>
  </header>
  <!-- claude.ai's own WebView2 covers this while nothing of the page does. -->
  <div class="page-slot" bind:this={slot}>
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-xl);
    padding: 0;
    width: min(1100px, calc(100vw - 32px));
    height: min(850px, calc(100dvh - 32px));
    max-width: none;
    max-height: none;
    overflow: hidden;
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
    animation: fade-in var(--duration) ease;
  }
  dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  dialog.side-panel {
    top: var(--mobile-top, 0px);
    margin: 0 0 0 auto;
    width: min(620px, 100vw);
    height: var(--mobile-height, 100dvh);
    border-radius: 0;
    border-width: 0 0 0 1px;
  }
  dialog.docked {
    position: relative;
    inset: auto;
    align-self: stretch;
    flex: 0 0 var(--artifact-panel-width, 42%);
    width: var(--artifact-panel-width, 42%);
    min-width: 360px;
    height: auto;
    min-height: 0;
    margin: 0;
    border: 0;
    border-left: 1px solid var(--border);
    border-radius: 0;
    box-shadow: none;
    background: var(--bg-sidebar);
  }
  .viewer-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 12px 20px;
    gap: 12px;
    border-bottom: 1px solid var(--border);
  }
  header > div {
    min-width: 0;
  }
  h2 {
    font-size: var(--text-lg);
    margin: 2px 0 0;
    overflow-wrap: anywhere;
  }
  /* Clear of the card's rounded corners, which the pane's square ones would cover. */
  .page-slot {
    flex: 1;
    min-height: 0;
    margin: 0 6px 6px;
    display: grid;
    place-items: center;
    padding: 16px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
  .page-slot p {
    margin: 0;
  }
  @media (max-width: 600px) {
    dialog {
      width: calc(100vw - 12px);
      height: calc(100dvh - 12px);
      border-radius: var(--radius-xl);
    }
    header {
      padding: 12px;
    }
  }
</style>
