// A claude.ai artifact shows inside the window in a WebView2 of its own, placed over the slot of
// the panel or dialog that holds it (`ClaudePageViewer.svelte`, `src-tauri/src/claude_pages.rs`).
// That WebView2 sits above the page, so it hides while anything of the page covers the slot: a
// dialog, a menu, a picker. These read the slot as the page lays it out.

/** A rectangle in the window, in CSS pixels. */
export type Place = { x: number; y: number; width: number; height: number };

// How far inside the slot's edges the points lie, and where across and down it they lie.
const INSET = 8;
const ACROSS = [0, 1 / 3, 2 / 3, 1];
const DOWN = [0, 0.25, 0.5, 0.75, 1];

/**
 * Points spread over the part of a slot inside the viewport, where anything covering it would
 * show: a menu reaching in from the chat beside it, or a dialog over everything.
 */
export function slotPoints(
  slot: Place,
  viewport: { width: number; height: number },
): [number, number][] {
  const left = Math.max(slot.x, 0) + INSET;
  const top = Math.max(slot.y, 0) + INSET;
  const right = Math.min(slot.x + slot.width, viewport.width) - INSET;
  const bottom = Math.min(slot.y + slot.height, viewport.height) - INSET;
  if (right < left || bottom < top) return [];
  return DOWN.flatMap((down) =>
    ACROSS.map((across): [number, number] => [
      left + (right - left) * across,
      top + (bottom - top) * down,
    ]),
  );
}

/**
 * Whether the slot is out of sight or something of the page covers it at any of its points:
 * `hit` names the topmost element at a point, as `document.elementFromPoint` does.
 */
export function slotCovered(
  slot: Element,
  place: Place,
  viewport: { width: number; height: number },
  hit: (x: number, y: number) => Element | null,
): boolean {
  const points = slotPoints(place, viewport);
  if (!points.length) return true;
  return points.some(([x, y]) => {
    const top = hit(x, y);
    return !top || !slot.contains(top);
  });
}

/** Whether a pane would show in the same place, to the pixel. */
export const samePlace = (a: Place | undefined, b: Place | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);
