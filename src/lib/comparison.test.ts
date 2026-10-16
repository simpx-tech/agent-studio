import { describe, expect, it } from 'vitest';
import {
  chatColumns,
  comparisonDetail,
  comparisonName,
  paneAspect,
  PaneSync,
  viewerColumns,
  type PanePlace,
  type PaneView,
  type SyncedPane,
} from './comparison';
import type { SentFile } from './sent-files';

/** A pane that shows one kind of view in each place, and records what it was asked to do. */
function pane(kind: PaneView['kind'] | undefined) {
  const shown: Partial<Record<PanePlace, PaneView>> = {};
  const actions: string[] = [];
  const view = (n: number): PaneView =>
    kind === 'image'
      ? { kind, view: { zoom: n, x: 0.5, y: 0.5 } }
      : kind === 'model'
        ? { kind, view: { position: [n, 0, 0], target: [0, 0, 0] } }
        : { kind: 'turn', turn: n };
  if (kind) shown.inline = shown.expanded = view(1);
  const synced: SyncedPane = {
    view: (place) => shown[place],
    follow(place, next) {
      if (next.kind !== kind) return;
      shown[place] = next;
      actions.push(`follow:${place}`);
    },
    zoom(place, factor) {
      actions.push(`zoom:${place}:${factor}`);
    },
    reset(place) {
      actions.push(`reset:${place}`);
    },
  };
  return { synced, shown, actions, view };
}

describe('PaneSync', () => {
  it('passes a move to the panes of its kind, in its place, only while synced', () => {
    const [a, b, model] = [pane('image'), pane('image'), pane('model')];
    const panes = new Map<string, SyncedPane>([
      ['a', a.synced],
      ['b', b.synced],
      ['model', model.synced],
    ]);
    const sync = new PaneSync(panes);
    sync.moved('a', 'inline', a.view(3));
    expect(b.shown.inline).toEqual(a.view(3));
    // The expanded view keeps its own, and a model takes no image's view.
    expect(b.shown.expanded).toEqual(b.view(1));
    expect(model.shown.inline).toEqual(model.view(1));
    expect(a.actions).toEqual([]);
    // Free: each pane on its own.
    sync.setSynced(false);
    sync.moved('b', 'inline', b.view(5));
    expect(a.shown.inline).toEqual(a.view(1));
  });

  it('syncs again from the pane moved last, kind by kind and place by place', () => {
    const [a, b, m, n] = [pane('image'), pane('image'), pane('model'), pane('model')];
    const panes = new Map<string, SyncedPane>([
      ['a', a.synced],
      ['b', b.synced],
      ['m', m.synced],
      ['n', n.synced],
    ]);
    const sync = new PaneSync(panes);
    sync.setSynced(false);
    // The reader moves each on its own, the second image and the first model last.
    for (const [key, view] of [
      ['a', a.view(2)],
      ['b', b.view(4)],
      ['n', n.view(6)],
      ['m', m.view(7)],
    ] as const) {
      const moved = { a, b, m, n }[key];
      moved.shown.inline = view;
      sync.moved(key, 'inline', view);
    }
    sync.setSynced(true);
    expect(a.shown.inline).toEqual(b.view(4));
    expect(n.shown.inline).toEqual(m.view(7));
    // Nothing moved in the file viewer, which keeps its own views.
    expect(a.actions.filter((action) => action.endsWith('expanded'))).toEqual([]);
  });

  it('acts on every pane in Free mode, and synced on one of each kind, which the rest follow', () => {
    const [a, b, m, unseen] = [pane('image'), pane('image'), pane('model'), pane(undefined)];
    const panes = new Map<string, SyncedPane>([
      ['a', a.synced],
      ['b', b.synced],
      ['m', m.synced],
      ['unseen', unseen.synced],
    ]);
    const sync = new PaneSync(panes);
    sync.zoom('inline', 1.25);
    // The first image, the model, and a pane not drawn yet, which has no view to follow.
    expect(a.actions).toEqual(['zoom:inline:1.25']);
    expect(b.actions).toEqual([]);
    expect(m.actions).toEqual(['zoom:inline:1.25']);
    expect(unseen.actions).toEqual(['zoom:inline:1.25']);
    // The image the reader moved last leads.
    sync.moved('b', 'expanded', b.view(2));
    sync.reset('expanded');
    expect(b.actions).toContain('reset:expanded');
    expect(a.actions).not.toContain('reset:expanded');
    sync.setSynced(false);
    sync.reset('inline');
    for (const each of [a, b, m, unseen]) expect(each.actions).toContain('reset:inline');
  });

  it('gives a pane drawn late the view its kind shares, while synced', () => {
    const [a, b, m] = [pane('image'), pane('image'), pane('model')];
    const panes = new Map<string, SyncedPane>([
      ['a', a.synced],
      ['b', b.synced],
      ['m', m.synced],
    ]);
    const sync = new PaneSync(panes);
    // Nothing moved yet: every pane shows its whole file.
    expect(sync.shared('b', 'inline', 'image')).toBeUndefined();
    a.shown.inline = a.view(3);
    sync.moved('a', 'inline', a.view(3));
    expect(sync.shared('b', 'inline', 'image')).toEqual(a.view(3));
    // Not the pane moved last itself, another kind, or another place.
    expect(sync.shared('a', 'inline', 'image')).toBeUndefined();
    expect(sync.shared('m', 'inline', 'model')).toBeUndefined();
    expect(sync.shared('b', 'expanded', 'image')).toBeUndefined();
    sync.setSynced(false);
    expect(sync.shared('b', 'inline', 'image')).toBeUndefined();
  });

  it('follows the panes as they join and leave', () => {
    const [a, b] = [pane('turn'), pane('turn')];
    const panes = new Map<string, SyncedPane>([['a', a.synced]]);
    const sync = new PaneSync(panes);
    panes.set('b', b.synced);
    sync.moved('a', 'inline', { kind: 'turn', turn: 3 });
    expect(b.shown.inline).toEqual({ kind: 'turn', turn: 3 });
    panes.delete('b');
    sync.moved('a', 'inline', { kind: 'turn', turn: 5 });
    expect(b.shown.inline).toEqual({ kind: 'turn', turn: 3 });
  });
});

const image = (width?: number, height?: number, label?: string): SentFile => ({
  index: 0,
  name: 'shot.png',
  mediaType: 'image/png',
  bytes: 1,
  width,
  height,
  label,
});
const model: SentFile = { index: 0, name: 'tree.glb', mediaType: 'model/gltf-binary', bytes: 1 };

it('shapes the panes after the widest image, square with a model', () => {
  expect(paneAspect([image(1920, 1080), image(1080, 1920)])).toBeCloseTo(16 / 9);
  expect(paneAspect([image(512, 512), image(2048, 2048)])).toBe(1);
  // Bounded, and a size that was not reported takes a common shape.
  expect(paneAspect([image(4000, 100), image(10, 10)])).toBe(2);
  expect(paneAspect([image(100, 4000), image(100, 4000)])).toBe(0.75);
  expect(paneAspect([image(), image()])).toBeCloseTo(4 / 3);
  expect(paneAspect([image(1920, 1080), model])).toBe(1);
});

it('lays up to three panes side by side in the chat, and four in two rows of two', () => {
  expect(chatColumns(2)).toEqual({ wide: 2, narrow: 2, rows: 1 });
  expect(chatColumns(3)).toEqual({ wide: 3, narrow: 2, rows: 1 });
  expect(chatColumns(4)).toEqual({ wide: 2, narrow: 2, rows: 2 });
  // Past four, rows of three, with no limit on how many.
  expect(chatColumns(5)).toEqual({ wide: 3, narrow: 2, rows: 2 });
  expect(chatColumns(7)).toEqual({ wide: 3, narrow: 2, rows: 3 });
  expect(chatColumns(12)).toEqual({ wide: 3, narrow: 2, rows: 4 });
});

it('lays the panes side by side in the file viewer, one above another on a tall screen', () => {
  expect(viewerColumns(2)).toEqual({ wide: 2, tall: 1 });
  expect(viewerColumns(3)).toEqual({ wide: 3, tall: 1 });
  expect(viewerColumns(4)).toEqual({ wide: 2, tall: 2 });
  expect(viewerColumns(6)).toEqual({ wide: 3, tall: 2 });
  expect(viewerColumns(9)).toEqual({ wide: 3, tall: 3 });
  expect(viewerColumns(12)).toEqual({ wide: 4, tall: 3 });
});

it('names a comparison by its labels, and details its kinds of files', () => {
  expect(comparisonName([image(1, 1, 'Before'), image(1, 1, 'After')])).toBe('Before vs After');
  expect(comparisonName([image(1, 1), model])).toBe('shot.png vs tree.glb');
  expect(comparisonDetail([image(), image()])).toBe('2 images');
  expect(comparisonDetail([model, model, model])).toBe('3 models');
  expect(comparisonDetail([image(), model])).toBe('1 image · 1 model');
});
