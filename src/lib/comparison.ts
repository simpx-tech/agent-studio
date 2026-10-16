/**
 * Files a reply compares side by side (compare_files), in the chat and in the file viewer. In
 * Free mode each pane turns, pans and zooms on its own; Synced passes what the reader does to one
 * pane to the panes of its kind beside it: the models keep one rotation, position and zoom, the
 * images one zoom and position, and the views another computer drew one turn.
 */
import type { Snippet } from 'svelte';
import type { SharedView } from './image-zoom';
import type { CameraView } from './model-scene';
import { isModel, paneLabel, type SentFile } from './sent-files';

export type PanePlace = 'inline' | 'expanded';
/** What a pane shows, as the panes beside it take it. A pane follows only its own kind. */
export type PaneView =
  | { kind: 'image'; view: SharedView }
  | { kind: 'model'; view: CameraView }
  | { kind: 'turn'; turn: number };
export type PaneKind = PaneView['kind'];

/** What syncing needs of a pane. */
export type SyncedPane = {
  /** What the pane shows in `place`, once it is drawn there. */
  view(place: PanePlace): PaneView | undefined;
  /** Shows what another pane shows, without reporting it. */
  follow(place: PanePlace, view: PaneView): void;
  zoom(place: PanePlace, factor: number): void;
  reset(place: PanePlace): void;
};
/** What a pane offers its comparison. */
export type ComparedPane = SyncedPane & {
  /** The pane at full size, in the file viewer's grid. */
  expanded: Snippet;
  /** The file viewer shows the comparison, so the pane in the chat gives up its scene. */
  shown(showing: boolean): void;
  /** Whether the pane's model carries an animation, and whether it plays. */
  readonly animated: boolean;
  readonly playing: boolean;
  setPlaying(playing: boolean): void;
};
/** What a comparison gives each of its panes: a place among them, and where to report moves. */
export type PaneLink = {
  join(key: string, pane: ComparedPane): () => void;
  moved(key: string, place: PanePlace, view: PaneView): void;
  /** What a pane drawn after the others moved shows: theirs, while synced. */
  shared(key: string, place: PanePlace, kind: PaneKind): PaneView | undefined;
};

export class PaneSync {
  synced = true;
  readonly #panes: Map<string, SyncedPane>;
  // The pane the reader moved last in each place, by kind, which leads when the views are
  // synced again and which the comparison's buttons act on while they are.
  readonly #lead: Record<PanePlace, Partial<Record<PaneKind, string>>> = {
    inline: {},
    expanded: {},
  };

  /** Syncs the panes `panes` holds, in its order, as they join and leave it. */
  constructor(panes: Map<string, SyncedPane>) {
    this.#panes = panes;
  }

  /** The reader moved a pane, which the others of its kind follow while the views are synced. */
  moved(key: string, place: PanePlace, view: PaneView) {
    this.#lead[place][view.kind] = key;
    if (this.synced) this.#follow(key, place, view);
  }
  #follow(key: string, place: PanePlace, view: PaneView) {
    for (const [other, pane] of this.#panes) if (other !== key) pane.follow(place, view);
  }

  /**
   * The view a pane drawn late takes, as an image still loading when the reader zoomed the one
   * beside it: that of the pane of its kind moved last, while the views are synced.
   */
  shared(key: string, place: PanePlace, kind: PaneKind): PaneView | undefined {
    const lead = this.#lead[place][kind];
    if (!this.synced || !lead || lead === key) return;
    const view = this.#panes.get(lead)?.view(place);
    return view?.kind === kind ? view : undefined;
  }

  /** Synced from Free: every pane takes the view of the one of its kind moved last. */
  setSynced(synced: boolean) {
    this.synced = synced;
    if (!synced) return;
    for (const place of ['inline', 'expanded'] as const)
      for (const key of Object.values(this.#lead[place])) {
        const view = key ? this.#panes.get(key)?.view(place) : undefined;
        if (view) this.#follow(key!, place, view);
      }
  }

  zoom(place: PanePlace, factor: number) {
    for (const pane of this.#acting(place)) pane.zoom(place, factor);
  }
  reset(place: PanePlace) {
    for (const pane of this.#acting(place)) pane.reset(place);
  }
  /**
   * The panes a button acts on: every pane in Free mode. Synced, one of each kind acts, the one
   * moved last or else the first, and the others follow it, which keeps them together exactly.
   */
  #acting(place: PanePlace): SyncedPane[] {
    const panes = [...this.#panes];
    if (!this.synced) return panes.map(([, pane]) => pane);
    const acting = new Map<PaneKind, SyncedPane>();
    const alone: SyncedPane[] = [];
    for (const [key, pane] of panes) {
      const kind = pane.view(place)?.kind;
      // A pane not drawn yet takes the view the others share once it is.
      if (!kind) alone.push(pane);
      else if (!acting.has(kind) || this.#lead[place][kind] === key) acting.set(kind, pane);
    }
    return [...acting.values(), ...alone];
  }
}

/**
 * The shape of every pane of a comparison: square when it shows a model, which turns, and
 * otherwise the shape of its widest image, from 3:4 to 2:1, so that image fills its pane and the
 * others are drawn whole beside it.
 */
export function paneAspect(files: SentFile[]): number {
  if (!files.length || files.some(isModel)) return 1;
  const widest = Math.max(
    ...files.map((file) => (file.width && file.height ? file.width / file.height : 4 / 3)),
  );
  return Math.min(2, Math.max(0.75, widest));
}

/**
 * How the panes stand in the chat: side by side up to three, two rows of two for four, and rows
 * of three past that, so four keep panes twice as wide as in one row. A comparison narrower than
 * a phone's chat holds two to a row (`narrow`). `rows` is the wide layout's, which shares the
 * window's height between them.
 */
export function chatColumns(count: number): { wide: number; narrow: number; rows: number } {
  const panes = Math.max(count, 1);
  const wide = panes === 4 ? 2 : Math.min(panes, 3);
  return { wide, narrow: Math.min(panes, 2), rows: Math.ceil(panes / wide) };
}

/**
 * How many columns the panes take in the file viewer: side by side up to three, in a square
 * grid past that; on a screen taller than wide, one above another up to three.
 */
export function viewerColumns(count: number): { wide: number; tall: number } {
  return {
    wide: count <= 3 ? Math.max(count, 1) : Math.ceil(Math.sqrt(count)),
    tall: count <= 3 ? 1 : Math.floor(Math.sqrt(count)),
  };
}

/** What the file viewer's heading calls a comparison. */
export const comparisonName = (files: SentFile[]) => files.map(paneLabel).join(' vs ');

/** The kinds of files a comparison holds, as its heading details them. */
export function comparisonDetail(files: SentFile[]): string {
  const models = files.filter(isModel).length;
  const images = files.length - models;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return [images && count(images, 'image'), models && count(models, 'model')]
    .filter(Boolean)
    .join(' · ');
}
