<script lang="ts">
  import { BaseEdge, getSmoothStepPath, Position, useNodes, type EdgeProps } from '@xyflow/svelte';
  import { edgeDetour } from '$lib/workflow-layout';
  // A connection of the workflow graph (docs/WORKFLOWS.md). Steps flow downwards, so one that
  // skips rows would run straight behind the steps between its ends and seem to join them: it
  // goes around them instead, in a lane beside them.
  let {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerStart,
    markerEnd,
    style,
    interactionWidth,
  }: EdgeProps = $props();
  const nodes = useNodes();
  const path = $derived.by(() => {
    const boxes = nodes.current
      .filter((n) => n.id !== source && n.id !== target)
      .map((n) => ({
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? n.width ?? 248,
        height: n.measured?.height ?? n.height ?? 96,
      }));
    const detour = edgeDetour(
      { x: sourceX, y: sourceY, side: sourcePosition === Position.Right ? 'right' : 'bottom' },
      { x: targetX, y: targetY },
      boxes,
    );
    return (
      detour ??
      getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      })[0]
    );
  });
</script>

<BaseEdge {id} {path} {markerStart} {markerEnd} {style} {interactionWidth} />
