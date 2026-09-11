<script lang="ts">
  import { onMount } from 'svelte';
  import { Maximize2, PanelRightOpen, RotateCcw } from '@lucide/svelte';
  import { artifactPreviewUrl } from '$lib/transport';
  import type { Visualization } from '$lib/visualizations';
  import { visualizationPreview } from '$lib/visualization-preview';
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
  let frame = $state<HTMLIFrameElement>();
  let height = $state(96);
  let sizeToken = '';
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
    function resize(event: MessageEvent) {
      const data = event.data;
      // Untrusted presentation telemetry can only resize its own bounded frame.
      if (
        !frame ||
        event.source !== frame.contentWindow ||
        data?.type !== 'studio-visualization-size' ||
        data.token !== sizeToken ||
        typeof data.height !== 'number' ||
        !Number.isFinite(data.height) ||
        data.height < 0
      )
        return;
      height = Math.max(24, Math.min(1600, Math.ceil(data.height)));
    }
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  });
  function initialize(event: Event) {
    const frame = event.currentTarget as HTMLIFrameElement;
    if (frame.dataset.initialized) return;
    frame.dataset.initialized = 'true';
    sizeToken = crypto.randomUUID();
    frame.contentWindow?.postMessage(visualizationPreview(visual.source, sizeToken), '*');
  }
</script>

<section class="visualization" aria-label={visual.title}>
  {#if error}<p role="status">{error}</p>{:else if url}{#key `${visual.revision}:${restart}`}<iframe
        bind:this={frame}
        title={`${visual.title} visualization`}
        src={url}
        style:height={`${height}px`}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        onload={initialize}
      ></iframe>{/key}{:else}<p role="status">Loading visualization…</p>{/if}
  <div class="visualization-actions">
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
</section>

<style>
  .visualization {
    min-width: 0;
    position: relative;
    margin: 0 0 13px;
    padding-bottom: 22px;
  }
  .visualization-actions {
    position: absolute;
    bottom: 0;
    right: 0;
    display: flex;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .visualization:hover .visualization-actions,
  .visualization:focus-within .visualization-actions {
    opacity: 1;
  }
  .visualization-actions button {
    width: 26px;
    height: 22px;
    color: var(--muted);
  }
  @media (hover: none), (max-width: 700px) {
    .visualization-actions {
      opacity: 1;
    }
    .visualization {
      padding-bottom: 34px;
    }
    .visualization-actions button {
      width: 36px;
      height: 34px;
    }
  }
  iframe {
    display: block;
    border: 0;
    width: 100%;
    background: transparent;
  }
  p {
    font-size: 12px;
  }
</style>
