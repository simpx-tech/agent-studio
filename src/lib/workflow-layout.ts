import { isNodeType, nodePorts } from './workflow-model';

/**
 * Places a workflow's steps or a mission's tasks in rows from top to bottom, each below the steps
 * it follows (docs/WORKFLOWS.md). Connections back to an earlier step, such as a review loop,
 * leave the rows as they are. A connection's `slot` is where its port sits along the bottom of
 * its card (0 at the left, 1 at the right), so the branches of a step keep its ports' order.
 */
export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { source: string; target: string; slot?: number };

/** A step card's size, before it is measured. */
export const STEP_WIDTH = 248;
export const STEP_HEIGHT = 96;

export function layeredLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  { gapX = 40, gapY = 64 }: { gapX?: number; gapY?: number } = {},
): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const outgoing = new Map<string, LayoutEdge[]>();
  for (const edge of edges)
    if (ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  // Leave out the connections that close a cycle, found by a depth-first walk in node order.
  const state = new Map<string, 1 | 2>();
  const forward: LayoutEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) {
      if (state.get(edge.target) === 1) continue;
      forward.push(edge);
      if (!state.has(edge.target)) visit(edge.target);
    }
    state.set(id, 2);
  };
  const incoming = new Map<string, number>();
  for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  for (const node of nodes) if (!incoming.get(node.id) && !state.has(node.id)) visit(node.id);
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  // Each node's row is the longest path to it.
  const row = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const predecessors = new Map<string, LayoutEdge[]>();
  for (const edge of forward)
    predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge]);
  const settled = new Set<string>();
  const depth = (id: string, path = new Set<string>()): number => {
    if (settled.has(id)) return row.get(id)!;
    path.add(id);
    let value = 0;
    for (const edge of predecessors.get(id) ?? [])
      if (!path.has(edge.source)) value = Math.max(value, depth(edge.source, path) + 1);
    path.delete(id);
    row.set(id, value);
    settled.add(id);
    return value;
  };
  for (const node of nodes) depth(node.id);
  const rows: LayoutNode[][] = [];
  for (const node of nodes) (rows[row.get(node.id)!] ??= []).push(node);
  // Order each row by where the ports it follows sit, then by the nodes' own order.
  const rank = new Map<string, number>();
  rows.forEach((list, index) => {
    if (index > 0)
      list.sort((a, b) => {
        const centre = (id: string) => {
          const sources = (predecessors.get(id) ?? []).filter((e) => rank.has(e.source));
          return sources.length
            ? sources.reduce((sum, e) => sum + rank.get(e.source)! + (e.slot ?? 0.5), 0) /
                sources.length
            : Number.POSITIVE_INFINITY;
        };
        const difference = centre(a.id) - centre(b.id);
        return Number.isFinite(difference) && difference
          ? difference
          : order.get(a.id)! - order.get(b.id)!;
      });
    list.forEach((node, i) => rank.set(node.id, i));
  });
  const widths = rows.map((list) =>
    (list ?? []).reduce((sum, n, i) => sum + n.width + (i ? gapX : 0), 0),
  );
  const heights = rows.map((list) => Math.max(0, ...(list ?? []).map((n) => n.height)));
  const widest = Math.max(0, ...widths);
  const positions = new Map<string, { x: number; y: number }>();
  let y = 0;
  rows.forEach((list, index) => {
    let x = (widest - widths[index]) / 2;
    for (const node of list ?? []) {
      positions.set(node.id, { x, y });
      x += node.width + gapX;
    }
    y += heights[index] + gapY;
  });
  return positions;
}

type Step = { id: string; type: string };
type Link = { source: string; target: string; sourcePort?: string };

/** A step's ports along the bottom of its card, in order; its error port leaves from its side. */
export const flowPorts = (type: string): string[] =>
  (isNodeType(type) ? nodePorts(type) : ['out']).filter((port) => port !== 'error');

/** Where a step's port sits along the bottom of its card, from 0 at the left to 1. */
export function portSlot(type: string, port = 'out'): number {
  if (port === 'error') return 1;
  const ports = flowPorts(type);
  const index = Math.max(0, ports.indexOf(port));
  return (index + 1) / (ports.length + 1);
}

/** A workflow's steps laid out top to bottom, each branch below the port it leaves from. */
export function arrangeSteps(
  steps: readonly Step[],
  links: readonly Link[],
): Map<string, { x: number; y: number }> {
  const types = new Map(steps.map((s) => [s.id, s.type]));
  return layeredLayout(
    steps.map((s) => ({ id: s.id, width: STEP_WIDTH, height: STEP_HEIGHT })),
    links.map((l) => ({
      source: l.source,
      target: l.target,
      slot: portSlot(types.get(l.source) ?? '', l.sourcePort),
    })),
  );
}

/**
 * Whether steps were laid out from left to right, as before graphs flowed downwards
 * (2026-10-19): most connections run sideways rather than down.
 */
export function flowsSideways(
  steps: readonly { id: string; position: { x: number; y: number } }[],
  links: readonly Link[],
): boolean {
  const at = new Map(steps.map((s) => [s.id, s.position]));
  let sideways = 0;
  let down = 0;
  for (const link of links) {
    const from = at.get(link.source);
    const to = at.get(link.target);
    if (!from || !to || link.source === link.target) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx > Math.abs(dy)) sideways++;
    else if (dy > 0) down++;
  }
  return sideways > down;
}

export type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** A polyline with rounded corners, as an SVG path. */
function rounded(points: Point[], radius: number): string {
  const kept = points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y,
  );
  let path = `M ${kept[0].x} ${kept[0].y}`;
  for (let i = 1; i < kept.length - 1; i++) {
    const [before, at, after] = [kept[i - 1], kept[i], kept[i + 1]];
    const into = Math.hypot(at.x - before.x, at.y - before.y);
    const out = Math.hypot(after.x - at.x, after.y - at.y);
    const r = Math.min(radius, into / 2, out / 2);
    const a = {
      x: at.x + ((before.x - at.x) / into) * r,
      y: at.y + ((before.y - at.y) / into) * r,
    };
    const b = { x: at.x + ((after.x - at.x) / out) * r, y: at.y + ((after.y - at.y) / out) * r };
    path += ` L ${a.x} ${a.y} Q ${at.x} ${at.y} ${b.x} ${b.y}`;
  }
  const last = kept[kept.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

/**
 * The path of a connection running down from the bottom of a step, around the steps that would
 * hide it: its usual path goes down, across halfway and down again, and a connection that skips
 * rows would run behind the steps between. It then leaves its port, takes a lane beside those
 * steps and enters its target from above. Undefined when nothing is in the way, for connections
 * that run upwards (a loop back) and for those leaving from a step's side.
 */
export function edgeDetour(
  from: Point & { side: 'bottom' | 'right' },
  to: Point,
  boxes: readonly Box[],
  { lead = 18, gap = 28, radius = 8 }: { lead?: number; gap?: number; radius?: number } = {},
): string | undefined {
  if (from.side !== 'bottom' || to.y - from.y <= 2 * lead) return undefined;
  const margin = 4;
  const across = (x: number, y0: number, y1: number, b: Box) =>
    b.x - margin < x && x < b.x + b.width + margin && b.y < y1 && b.y + b.height > y0;
  const along = (y: number, x0: number, x1: number, b: Box) =>
    b.y - margin < y &&
    y < b.y + b.height + margin &&
    b.x < Math.max(x0, x1) &&
    b.x + b.width > Math.min(x0, x1);
  const middle = (from.y + to.y) / 2;
  const blocked = boxes.some(
    (b) =>
      across(from.x, from.y, middle, b) ||
      along(middle, from.x, to.x, b) ||
      across(to.x, middle, to.y, b),
  );
  if (!blocked) return undefined;
  const top = from.y + lead;
  const bottom = to.y - lead;
  // A lane on each side, moved out until no step stands in it.
  const lane = (side: -1 | 1) => {
    const near = boxes.filter((b) => b.y < bottom && b.y + b.height > top);
    let x =
      side < 0
        ? Math.min(
            from.x,
            to.x,
            ...near
              .filter((b) => across(from.x, top, bottom, b) || across(to.x, top, bottom, b))
              .map((b) => b.x),
          ) - gap
        : Math.max(
            from.x,
            to.x,
            ...near
              .filter((b) => across(from.x, top, bottom, b) || across(to.x, top, bottom, b))
              .map((b) => b.x + b.width),
          ) + gap;
    for (let i = 0; i < near.length; i++) {
      const hit = near.filter((b) => across(x, top, bottom, b));
      if (!hit.length) break;
      x =
        side < 0
          ? Math.min(...hit.map((b) => b.x)) - gap
          : Math.max(...hit.map((b) => b.x + b.width)) + gap;
    }
    return x;
  };
  const left = lane(-1);
  const right = lane(1);
  const cost = (x: number) => Math.abs(from.x - x) + Math.abs(to.x - x);
  const x = cost(left) <= cost(right) ? left : right;
  return rounded(
    [
      { x: from.x, y: from.y },
      { x: from.x, y: top },
      { x, y: top },
      { x, y: bottom },
      { x: to.x, y: bottom },
      { x: to.x, y: to.y },
    ],
    radius,
  );
}
