<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { X, Download, RotateCcw, Code, Eye } from '@lucide/svelte';
  import type { Artifact } from '$lib/artifacts';
  import { artifactFilename } from '$lib/artifacts';
  import { artifactPreviewUrl, downloadArtifact } from '$lib/transport';
  let { artifact, close }: { artifact: Artifact; close: () => void } = $props();
  let tab = $state<'preview' | 'source'>('preview');
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
  let dialog: HTMLDialogElement;
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.showModal();
    void artifactPreviewUrl()
      .then((value) => (url = value))
      .catch(() => (error = 'Could not open the artifact preview. The source is still available.'));
    return () => focused?.isConnected && focused.focus();
  });
  function initialize(event: Event) {
    // Send once to the constant renderer; artifact-authored messages are never handled by the app.
    const frame = event.currentTarget as HTMLIFrameElement;
    if (frame.dataset.initialized) return;
    frame.dataset.initialized = 'true';
    frame.contentWindow?.postMessage({ type: 'studio-artifact', source: artifact.source }, '*');
  }
</script>

<dialog
  bind:this={dialog}
  class="artifact-viewer"
  aria-labelledby="artifact-title"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <header>
    <div>
      <span class="eyebrow">ARTIFACT</span>
      <h2 id="artifact-title">{artifact.title}</h2>
    </div>
    <button class="icon-button" onclick={close} aria-label="Close artifact"><X size={19} /></button>
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
              dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
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
    role="tabpanel"
    aria-label={tab === 'preview' ? 'Artifact preview' : 'Artifact source'}
  >
    {#if tab === 'preview'}
      {#if error}<p role="alert">{error}</p>{:else if url}{#key revision}<iframe
            title={`${artifact.title} preview`}
            src={url}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onload={initialize}
          ></iframe>{/key}{:else}<p>Loading preview…</p>{/if}
    {:else}<pre><code>{artifact.source}</code></pre>{/if}
  </div>
  <footer>
    <span role="status">{downloadStatus}</span>Self-contained HTML and SVG · External resources are
    blocked in preview.
  </footer>
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
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
    background: #080b0dcc;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    gap: 12px;
  }
  header > div {
    min-width: 0;
  }
  h2 {
    font-size: 17px;
    margin: 3px 0 0;
    overflow-wrap: anywhere;
  }
  .artifact-toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    border-block: 1px solid var(--line);
    padding: 9px 16px;
  }
  [role='tablist'] {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  [role='tab'] {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border-radius: 7px;
    background: transparent;
    color: var(--muted);
  }
  [aria-selected='true'] {
    background: #ffffff0d;
    color: var(--text);
  }
  .artifact-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: white;
    color: #15191c;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  pre {
    margin: 0;
    padding: 20px;
    font-size: 12px;
    tab-size: 2;
    min-height: 100%;
    box-sizing: border-box;
    background: #111715;
    color: #d9e2dc;
  }
  footer {
    padding: 10px 16px;
    font-size: 10px;
    color: var(--muted);
  }
  footer > span:not(:empty) {
    display: block;
    margin-bottom: 5px;
  }
  @media (max-width: 600px) {
    dialog {
      width: calc(100vw - 12px);
      height: calc(100dvh - 12px);
      border-radius: 10px;
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
