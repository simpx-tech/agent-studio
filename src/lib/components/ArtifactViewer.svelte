<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { X, Download, RotateCcw, Code, Eye, PanelRightOpen, Maximize2 } from '@lucide/svelte';
  import type { Artifact } from '$lib/artifacts';
  import { artifactFilename } from '$lib/artifacts';
  import { visualizationPreview } from '$lib/visualization-preview';
  import { appearance } from '$lib/appearance.svelte';
  import { highlightCode } from '$lib/markdown';
  import { artifactPreviewUrl, downloadArtifact } from '$lib/transport';
  import ArtifactResize from './ArtifactResize.svelte';
  let {
    artifact,
    mode = 'modal',
    changeMode,
    close,
  }: {
    artifact: Artifact;
    mode?: 'modal' | 'panel';
    changeMode: (mode: 'modal' | 'panel') => void;
    close: () => void;
  } = $props();
  let viewportWidth = $state(0);
  let workspaceWidth = $state(0);
  let panelWidth = $state<number>();
  const docked = $derived(mode === 'panel' && viewportWidth >= 1100 && workspaceWidth >= 780);
  let tab = $state<'preview' | 'source'>('preview');
  const highlightedSource = $derived(
    tab === 'source' ? highlightCode(artifact.source, artifact.language) : null,
  );
  let url = $state('');
  let error = $state('');
  let downloadStatus = $state('');
  async function download() {
    try {
      const path = await downloadArtifact(
        artifact.source,
        artifactFilename(artifact),
        artifact.language,
      );
      downloadStatus = path ? 'Saved to Downloads.' : 'Download started.';
    } catch (e) {
      downloadStatus = `Download failed: ${String(e)}`;
    }
  }
  let revision = $state(0);
  let dialog = $state<HTMLDialogElement>();
  let mounted = $state(false);
  $effect(() => {
    if (!mounted || !dialog) return;
    // Keep the same sandboxed iframe when changing presentation.
    dialog.close();
    if (docked) dialog.show();
    else dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close artifact"]')?.focus();
  });
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    const workspace = dialog?.parentElement;
    const observer = new ResizeObserver(() => {
      if (workspace) workspaceWidth = workspace.getBoundingClientRect().width;
    });
    if (workspace) {
      workspaceWidth = workspace.getBoundingClientRect().width;
      observer.observe(workspace);
    }
    mounted = true;
    void artifactPreviewUrl()
      .then((value) => (url = value))
      .catch(() => (error = 'Could not open the artifact preview. The source is still available.'));
    return () => {
      observer.disconnect();
      if (focused?.isConnected) focused.focus();
    };
  });
  function initialize(event: Event) {
    // Send once to the constant renderer; this expanded viewer accepts no child messages.
    const frame = event.currentTarget as HTMLIFrameElement;
    if (frame.dataset.initialized) return;
    frame.dataset.initialized = 'true';
    frame.contentWindow?.postMessage(
      artifact.visualization
        ? visualizationPreview(artifact.source, undefined, appearance.resolved)
        : {
            type: 'studio-artifact',
            source: artifact.source,
          },
      '*',
    );
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} />
<dialog
  bind:this={dialog}
  id="artifact-viewer"
  class="artifact-viewer"
  style:--artifact-panel-width={panelWidth ? `${panelWidth}px` : undefined}
  class:side-panel={mode === 'panel'}
  class:docked
  aria-modal={docked ? undefined : 'true'}
  aria-labelledby="artifact-title"
  onkeydown={(event) => {
    if (docked && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  {#if docked}<ArtifactResize
      availableWidth={workspaceWidth}
      onresize={(width) => (panelWidth = width)}
    />{/if}
  <header>
    <div>
      <span class="eyebrow">Artifact</span>
      <h2 id="artifact-title">{artifact.title}</h2>
    </div>
    <div class="viewer-actions">
      <button
        class="icon-button"
        onclick={() => changeMode(mode === 'panel' ? 'modal' : 'panel')}
        aria-label={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        title={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        >{#if mode === 'panel'}<Maximize2 size={17} />{:else}<PanelRightOpen
            size={17}
          />{/if}</button
      >
      <button class="icon-button" onclick={close} aria-label="Close artifact"
        ><X size={19} /></button
      >
    </div>
  </header>
  <div class="artifact-toolbar">
    <div role="tablist" aria-label="Artifact view">
      {#each ['preview', 'source'] as item, index}<button
          role="tab"
          aria-selected={tab === item}
          tabindex={tab === item ? 0 : -1}
          onclick={() => (tab = item as typeof tab)}
          onkeydown={async (event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              tab =
                event.key === 'Home'
                  ? 'preview'
                  : event.key === 'End'
                    ? 'source'
                    : tab === 'preview'
                      ? 'source'
                      : 'preview';
              await tick();
              dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            }
          }}
          >{#if index === 0}<Eye size={14} />{:else}<Code size={14} />{/if}{index === 0
            ? 'Preview'
            : 'Source'}</button
        >{/each}
    </div>
    <button
      class="text-button"
      onclick={() => revision++}
      title="Restart preview"
      aria-label="Restart preview"><RotateCcw size={14} /></button
    >
    <button class="secondary" onclick={download}><Download size={14} />Download</button>
  </div>
  <div
    class="artifact-content"
    class:visualization-preview={artifact.visualization && tab === 'preview'}
    role="tabpanel"
    aria-label={tab === 'preview' ? 'Artifact preview' : 'Artifact source'}
  >
    {#if tab === 'preview'}
      {#if error}<p role="alert">
          {error}
        </p>{:else if url}{#key `${artifact.id}:${artifact.revision ?? 0}:${revision}:${artifact.visualization ? appearance.resolved : ''}`}<iframe
            title={`${artifact.title} preview`}
            src={url}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onload={initialize}
          ></iframe>{/key}{:else}<p>Loading preview…</p>{/if}
    {:else}<pre><code class="hljs"
          >{#if highlightedSource}{@html highlightedSource.html}{:else}{artifact.source}{/if}</code
        ></pre>{/if}
  </div>
  <footer>
    <span role="status">{downloadStatus}</span>Self-contained HTML and SVG · External resources are
    blocked in preview.
  </footer>
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
  }
  header > div {
    min-width: 0;
  }
  h2 {
    font-size: var(--text-lg);
    margin: 2px 0 0;
    overflow-wrap: anywhere;
  }
  .artifact-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    border-block: 1px solid var(--border);
    padding: 8px 14px;
  }
  [role='tablist'] {
    display: flex;
    gap: 2px;
    flex: 1;
  }
  [role='tab'] {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  [role='tab']:not(:disabled):hover {
    background: var(--hover);
  }
  [aria-selected='true'],
  [aria-selected='true']:not(:disabled):hover {
    background: var(--active);
    color: var(--text);
  }
  .artifact-toolbar .text-button {
    width: var(--control-md);
    height: var(--control-md);
    padding: 0;
    border-radius: var(--radius-md);
    color: var(--text-muted);
  }
  .artifact-toolbar .text-button:not(:disabled):hover {
    background: var(--hover);
    color: var(--text);
  }
  .artifact-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--artifact-canvas);
    color: var(--artifact-ink);
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .visualization-preview {
    background: var(--bg);
    color: var(--text);
    padding: 16px;
  }
  pre {
    margin: 0;
    padding: 20px;
    font-size: 12.5px;
    line-height: 1.65;
    tab-size: 2;
    min-height: 100%;
    box-sizing: border-box;
    background: var(--code-bg);
    color: var(--code-text);
  }
  footer {
    padding: 9px 16px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  footer > span:not(:empty) {
    display: block;
    margin-bottom: 5px;
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
    .artifact-toolbar {
      padding: 8px;
      gap: 6px;
    }
  }
</style>
