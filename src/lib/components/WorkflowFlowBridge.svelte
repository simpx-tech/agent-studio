<script lang="ts">
  import { useSvelteFlow } from '@xyflow/svelte';
  // Hands the canvas what only the flow's own children can reach: turning a point on screen into
  // a place on the graph, where a connection dropped on empty space puts its new step.
  let {
    ready,
  }: {
    ready: (api: { toFlow: (x: number, y: number) => { x: number; y: number } }) => void;
  } = $props();
  const flow = useSvelteFlow();
  // svelte-ignore state_referenced_locally
  ready({ toFlow: (x, y) => flow.screenToFlowPosition({ x, y }) });
</script>
