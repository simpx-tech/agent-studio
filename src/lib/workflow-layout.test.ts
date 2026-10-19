import { describe, expect, it } from 'vitest';
import {
  arrangeSteps,
  edgeDetour,
  flowsSideways,
  layeredLayout,
  portSlot,
  STEP_HEIGHT,
  STEP_WIDTH,
} from './workflow-layout';

describe('workflow layout', () => {
  it('lays steps out from top to bottom, branches side by side in their ports’ order', () => {
    const steps = [
      { id: 'start', type: 'start' },
      { id: 'check', type: 'condition' },
      // Listed before the true branch, the false branch still goes on the right.
      { id: 'no', type: 'end' },
      { id: 'yes', type: 'end' },
    ];
    const links = [
      { source: 'start', target: 'check' },
      { source: 'check', sourcePort: 'false', target: 'no' },
      { source: 'check', sourcePort: 'true', target: 'yes' },
    ];
    const at = arrangeSteps(steps, links);
    expect(at.get('start')!.y).toBeLessThan(at.get('check')!.y);
    expect(at.get('check')!.y).toBeLessThan(at.get('yes')!.y);
    expect(at.get('yes')!.y).toBe(at.get('no')!.y);
    expect(at.get('yes')!.x).toBeLessThan(at.get('no')!.x);
    // A single step of a row sits in the middle of the widest row.
    const middle = (id: string) => at.get(id)!.x + STEP_WIDTH / 2;
    expect(middle('start')).toBe((middle('yes') + middle('no')) / 2);
  });

  it('keeps a loop back from moving the steps it returns to', () => {
    const at = layeredLayout(
      ['a', 'b', 'c'].map((id) => ({ id, width: 100, height: 50 })),
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'b' },
      ],
    );
    expect([at.get('a')!.y, at.get('b')!.y, at.get('c')!.y]).toEqual([0, 114, 228]);
  });

  it('places ports along the bottom, the error port at the side', () => {
    expect(portSlot('condition', 'true')).toBeLessThan(portSlot('condition', 'false'));
    expect(portSlot('agent', 'out')).toBe(0.5);
    expect(portSlot('agent', 'error')).toBe(1);
  });

  it('tells graphs laid out from left to right', () => {
    const links = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const sideways = ['a', 'b', 'c'].map((id, i) => ({ id, position: { x: i * 328, y: 0 } }));
    expect(flowsSideways(sideways, links)).toBe(true);
    const down = ['a', 'b', 'c'].map((id, i) => ({ id, position: { x: 0, y: i * 160 } }));
    expect(flowsSideways(down, links)).toBe(false);
  });

  it('routes a connection that skips rows around the steps between its ends', () => {
    const card = (x: number, y: number) => ({ x, y, width: STEP_WIDTH, height: STEP_HEIGHT });
    // A connection from the bottom of a step at the top to a step three rows down, with two steps
    // in the same column between them.
    const from = { x: 124, y: STEP_HEIGHT, side: 'bottom' as const };
    const to = { x: 124, y: 3 * 160 };
    const between = [card(0, 160), card(0, 320)];
    const path = edgeDetour(from, to, between)!;
    expect(path).toBeTruthy();
    // It leaves the column: every point stays outside the steps between.
    const xs = [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeLessThan(0);
    // Nothing in the way, or a connection back up, keeps the usual path.
    expect(edgeDetour(from, to, [])).toBeUndefined();
    expect(edgeDetour({ ...from, y: 400 }, { x: 124, y: 0 }, between)).toBeUndefined();
    // A lane already taken by another step moves further out.
    const beside = card(-STEP_WIDTH - 20, 160);
    const around = edgeDetour(from, to, [...between, beside])!;
    const lane = [...around.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1]),
    );
    expect(lane.every((x) => x < beside.x || x > 0)).toBe(true);
  });
});
