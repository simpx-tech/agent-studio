<script lang="ts">
  import { onMount } from 'svelte';
  import { Maximize2, PanelRightOpen, RotateCcw } from '@lucide/svelte';
  import { artifactPreviewUrl } from '$lib/transport';
  import { visualizationDocument, type Visualization } from '$lib/visualizations';
  import type { Artifact } from '$lib/artifacts';
  let {
    visual,
    messageId,
    openArtifact,
  }: {
    visual: Visualization;
    messageId: string;
    openArtifact: (artifact: Artifact, mode?: 'modal' | 'panel') => void;
  } = $props();
  let url = $state('');
  let error = $state('');
  let restart = $state(0);
  const artifact = $derived<Artifact>({
    id: `${messageId}:visual:${visual.id}`,
    title: visual.title,
    language: 'html',
    source: visual.source,
    visualization: true,
    revision: visual.revision,
  });
  onMount(() => {
    void artifactPreviewUrl()
      .then((value) => (url = value))
      .catch(() => (error = 'Preview unavailable. Open the source to view or download it.'));
  });
  function initialize(event: Event) {
    const frame = event.currentTarget as HTMLIFrameElement;
    if (frame.dataset.initialized) return;
    frame.dataset.initialized = 'true';
    frame.contentWindow?.postMessage(
      { type: 'studio-artifact', source: visualizationDocument(visual.source) },
      '*',
    );
  }
</script>

<section class="visualization" aria-label={visual.title}>
  <header>
    <strong>{visual.title}</strong>
    <div>
      <button
        class="icon-button"
        aria-label={`Restart ${visual.title}`}
        title="Restart"
        onclick={() => restart++}><RotateCcw size={15} /></button
      >
      <button
        class="icon-button"
        aria-label={`Open ${visual.title} in side panel`}
        title="Open in side panel"
        onclick={() => openArtifact(artifact, 'panel')}><PanelRightOpen size={15} /></button
      >
      <button
        class="icon-button"
        aria-label={`Expand ${visual.title}`}
        title="Expand and view source"
        onclick={() => openArtifact(artifact)}><Maximize2 size={15} /></button
      >
    </div>
  </header>
  {#if error}<p role="status">{error}</p>{:else if url}{#key `${visual.revision}:${restart}`}<iframe
        title={`${visual.title} visualization`}
        src={url}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        onload={initialize}
      ></iframe>{/key}{:else}<p role="status">Loading visualization…</p>{/if}
</section>

<style>
  .visualization {
    min-width: 0;
    margin: 14px 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
  }
  strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  header div {
    display: flex;
    flex-shrink: 0;
  }
  iframe {
    display: block;
    border: 0;
    width: 100%;
    height: 360px;
    max-height: 65dvh;
    background: var(--surface);
  }
  p {
    padding: 12px;
    font-size: 12px;
  }
</style>
