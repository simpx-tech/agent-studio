/**
 * Places a workflow's steps or a mission's tasks in columns from left to right, each after the
 * steps it follows (docs/WORKFLOWS.md). Connections back to an earlier step, such as a review
 * loop, leave the columns as they are.
 */
export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { source: string; target: string };

export function layeredLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  { gapX = 80, gapY = 32 }: { gapX?: number; gapY?: number } = {},
): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges)
    if (ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  // Leave out the connections that close a cycle, found by a depth-first walk in node order.
  const state = new Map<string, 1 | 2>();
  const forward: LayoutEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      if (state.get(next) === 1) continue;
      forward.push({ source: id, target: next });
      if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  const incoming = new Map<string, number>();
  for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  for (const node of nodes) if (!incoming.get(node.id) && !state.has(node.id)) visit(node.id);
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  // Each node's column is the longest path to it.
  const column = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const predecessors = new Map<string, string[]>();
  for (const edge of forward)
    predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge.source]);
  const settled = new Set<string>();
  const depth = (id: string, path = new Set<string>()): number => {
    if (settled.has(id)) return column.get(id)!;
    path.add(id);
    let value = 0;
    for (const source of predecessors.get(id) ?? [])
      if (!path.has(source)) value = Math.max(value, depth(source, path) + 1);
    path.delete(id);
    column.set(id, value);
    settled.add(id);
    return value;
  };
  for (const node of nodes) depth(node.id);
  const columns: LayoutNode[][] = [];
  for (const node of nodes) (columns[column.get(node.id)!] ??= []).push(node);
  // Order each column by where the nodes it follows sit, then by their own order.
  const rank = new Map<string, number>();
  columns.forEach((list, index) => {
    if (index > 0)
      list.sort((a, b) => {
        const centre = (id: string) => {
          const sources = (predecessors.get(id) ?? []).filter((s) => rank.has(s));
          return sources.length
            ? sources.reduce((sum, s) => sum + rank.get(s)!, 0) / sources.length
            : Number.POSITIVE_INFINITY;
        };
        const difference = centre(a.id) - centre(b.id);
        return Number.isFinite(difference) && difference
          ? difference
          : order.get(a.id)! - order.get(b.id)!;
      });
    list.forEach((node, i) => rank.set(node.id, i));
  });
  const widths = columns.map((list) => Math.max(0, ...(list ?? []).map((n) => n.width)));
  const heights = columns.map((list) =>
    (list ?? []).reduce((sum, n, i) => sum + n.height + (i ? gapY : 0), 0),
  );
  const tallest = Math.max(0, ...heights);
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  columns.forEach((list, index) => {
    let y = (tallest - heights[index]) / 2;
    for (const node of list ?? []) {
      positions.set(node.id, { x, y });
      y += node.height + gapY;
    }
    x += widths[index] + gapX;
  });
  return positions;
}
