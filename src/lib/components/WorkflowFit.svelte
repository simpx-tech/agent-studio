<script lang="ts">
  import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte';
  // Fits the graph into view once its cards are measured and whenever `token` changes, as after a
  // step is added or the canvas changes size. A graph too big to read whole shows its start at a
  // readable size instead: its top, centred while it is narrower than the view.
  let {
    token,
    width,
    height,
    readable = 0.65,
  }: {
    token: number;
    width: number;
    height: number;
    /** The smallest zoom that fits a whole graph; a bigger one shows its start at this zoom. */
    readable?: number;
  } = $props();
  const flow = useSvelteFlow();
  const initialized = useNodesInitialized();
  // Room at the sides, and at the top for the tools that float over the graph.
  const pad = 24;
  const top = 56;
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
    const place = (size: number, room: number, from: number, start: number) =>
      size * readable < room - start - pad
        ? (room - size * readable) / 2 - from * readable
        : start - from * readable;
    void flow.setViewport(
      {
        x: place(bounds.width, width, bounds.x, pad),
        y: place(bounds.height, height, bounds.y, top),
        zoom: readable,
      },
      { duration },
    );
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
