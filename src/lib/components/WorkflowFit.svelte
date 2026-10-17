<script lang="ts">
  import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte';
  // Fits the graph into view once its cards are measured and whenever `token` changes, as after a
  // step is added or the canvas changes size. A graph too wide to read whole shows its start at a
  // readable size instead, since the graph reads from left to right.
  let { token, width, height }: { token: number; width: number; height: number } = $props();
  const flow = useSvelteFlow();
  const initialized = useNodesInitialized();
  const readable = 0.65;
  const pad = 24;
  let fitted = false;
  let seen: number | undefined;
  function fit(duration = 200) {
    const nodes = flow.getNodes();
    if (!nodes.length || !width || !height) return;
    const bounds = flow.getNodesBounds(nodes);
    // The zoom fitView reaches with its padding.
    const zoom = Math.min(
      1,
      (width * 0.85) / Math.max(1, bounds.width),
      (height * 0.85) / Math.max(1, bounds.height),
    );
    if (zoom >= readable) {
      void flow.fitView({ padding: 0.15, maxZoom: 1, duration });
      return;
    }
    const y =
      bounds.height * readable < height - 2 * pad
        ? (height - bounds.height * readable) / 2 - bounds.y * readable
        : pad - bounds.y * readable;
    void flow.setViewport({ x: pad - bounds.x * readable, y, zoom: readable }, { duration });
  }
  // Once the cards and the canvas are both measured.
  $effect(() => {
    if (!initialized.current || !width || !height || fitted) return;
    fitted = true;
    requestAnimationFrame(() => fit(0));
  });
  $effect(() => {
    const current = token;
    if (seen === undefined) {
      seen = current;
      return;
    }
    if (current === seen) return;
    seen = current;
    requestAnimationFrame(() => fit());
  });
</script>
