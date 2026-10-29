import { describe, expect, it } from 'vitest';
import { samePlace, slotCovered, slotPoints } from './claude-pages';

const viewport = { width: 1380, height: 900 };
const slot = { x: 900, y: 110, width: 460, height: 770 };

describe('claude.ai panes', () => {
  it('reads points across the slot inside its edges', () => {
    const points = slotPoints(slot, viewport);
    expect(points).toHaveLength(20);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(slot.x + 8);
      expect(x).toBeLessThanOrEqual(slot.x + slot.width - 8);
      expect(y).toBeGreaterThanOrEqual(slot.y + 8);
      expect(y).toBeLessThanOrEqual(slot.y + slot.height - 8);
    }
    // The corners are read, where a menu from the chat beside it reaches in first.
    expect(points).toContainEqual([slot.x + 8, slot.y + 8]);
    expect(points).toContainEqual([slot.x + slot.width - 8, slot.y + slot.height - 8]);
  });

  it('reads only the part of a slot inside the window', () => {
    const past = slotPoints({ ...slot, height: 2000 }, viewport);
    expect(Math.max(...past.map(([, y]) => y))).toBe(viewport.height - 8);
    expect(slotPoints({ ...slot, x: 1500 }, viewport)).toEqual([]);
  });

  it('counts a slot as covered when anything else is on top at any point', () => {
    // The slot, and the message it shows while its pane is hidden.
    const own = {} as Element;
    const holder = { contains: (other: unknown) => other === holder || other === own };
    const hit = holder as unknown as Element;
    expect(slotCovered(hit, slot, viewport, () => own)).toBe(false);
    expect(slotCovered(hit, slot, viewport, () => hit)).toBe(false);
    // A menu over its left edge.
    const menu = {} as Element;
    expect(slotCovered(hit, slot, viewport, (x) => (x < slot.x + 100 ? menu : own))).toBe(true);
    // A dialog over everything, and a slot out of sight.
    expect(slotCovered(hit, slot, viewport, () => menu)).toBe(true);
    expect(slotCovered(hit, slot, viewport, () => null)).toBe(true);
    expect(slotCovered(hit, { ...slot, x: 1500 }, viewport, () => own)).toBe(true);
  });

  it('places a pane again only when it moves a pixel', () => {
    expect(samePlace(slot, { ...slot, x: slot.x + 0.3 })).toBe(true);
    expect(samePlace(slot, { ...slot, width: slot.width + 1 })).toBe(false);
    expect(samePlace(undefined, undefined)).toBe(true);
    expect(samePlace(slot, undefined)).toBe(false);
  });
});
