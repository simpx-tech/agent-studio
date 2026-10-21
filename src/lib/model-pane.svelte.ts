/**
 * One shown 3D model and the stages that show it: inline in the chat and full size in the file
 * viewer. Both share its bytes, its animation and, when only the computer that keeps it could
 * draw it, its turntable views; each builds a scene of its own. A reply's model and each model
 * of a comparison keep one, created while their component is set up.
 */
import {
  createFetchCache,
  formatBytes,
  modelFormats,
  modelViewCount,
  toolOutputImageUrl,
  type ModelViews,
  type ToolOutputModelType,
} from './tool-output';
import {
  modelFromAnotherComputer,
  readToolOutputModel,
  readToolOutputModelViews,
} from './transport';
import type { SentFile } from './sent-files';
import { createModelViewer, whenNear, type ModelViewer, type ViewerStatus } from './model-viewer';
import type { CameraView, ModelFormat } from './model-scene';
import { modelLighting } from './model-lighting.svelte';

// Models a window already read, as decoded bytes, bounded so several heavy files cannot
// pile up. The inline and expanded views of a model share its entry; a model larger than
// the whole budget is read again whenever its scene is built instead of kept.
const keptBytes = 64_000_000;
const models = createFetchCache<{ format: ModelFormat; bytes: ArrayBuffer }>(
  (model) => model.bytes.byteLength,
  { entries: 6, bytes: keptBytes },
);
// Views of models another computer keeps, which that computer renders once.
const modelViews = createFetchCache<ModelViews>(
  (read) => read.views.reduce((total, view) => total + view.data.length, 0),
  { entries: 12, bytes: 48_000_000 },
);
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where a model is shown: in the chat, or full size in the file viewer. */
export type ModelPlace = 'inline' | 'expanded';
export type ModelSource = {
  runId: string;
  toolId: string;
  connectionId?: string;
  file: SentFile;
};
export type ViewsStatus =
  { phase: 'loading' } | { phase: 'ready'; urls: string[] } | { phase: 'failed'; message: string };
/** What the reader does to a model, which a comparison passes on to the models beside it. */
export type ModelHooks = {
  /** The reader moved the camera of the scene in `place`. */
  moved?(place: ModelPlace, view: CameraView): void;
  /** The reader turned through the views another computer drew. */
  turned?(turn: number): void;
};

export class ModelPane {
  readonly #source: () => ModelSource;
  readonly #hooks: ModelHooks;
  readonly name = $derived.by(() => this.#source().file.name);
  /** The loader follows the format the computer recognized in the file itself. */
  readonly format = $derived.by(
    (): ModelFormat => modelFormats[this.#source().file.mediaType as ToolOutputModelType] ?? 'glb',
  );
  readonly label = $derived.by(
    () => `${this.format.toUpperCase()} · ${formatBytes(this.#source().file.bytes)}`,
  );
  // Only the model's identity selects it: relay updates of the reply do not reload it, while
  // a group sent again under the same id builds the model it now names.
  readonly key = $derived.by(() => {
    const { runId, toolId, file } = this.#source();
    return `${runId}\n${toolId}\n${file.index}\n${file.mediaType}`;
  });
  /** A model this window can keep between scenes is read once, ahead of its stage. */
  readonly kept = $derived.by(() => this.#source().file.bytes <= keptBytes);
  // Another computer's model is read whole, however large. One that cannot come whole (a relay
  // or device on the way that cannot carry it) shows views that computer renders instead, a
  // turn apart, which the reader turns through.
  #viewsFor = $state('');
  readonly viewsOnly = $derived.by(() => this.#viewsFor === this.key);
  views = $state<ViewsStatus>({ phase: 'loading' });
  turn = $state(0);
  #viewsKey = '';
  clips = $state<string[]>([]);
  clip = $state(0);
  // Animations play on their own unless the reader asked for less motion.
  playing = $state(!reducedMotion());
  statuses = $state<Partial<Record<ModelPlace, ViewerStatus>>>({});
  readonly #viewers: Partial<Record<ModelPlace, ModelViewer>> = {};
  // Whether the file viewer shows the model, whose inline stage then gives up its scene.
  #expanded = false;

  constructor(source: () => ModelSource, hooks: ModelHooks = {}) {
    this.#source = source;
    this.#hooks = hooks;
    // Every model in the window takes the light chosen last, from any of them.
    $effect(() => {
      const lighting = modelLighting.value;
      this.#each((viewer) => viewer.setLighting(lighting));
    });
  }

  #each(act: (viewer: ModelViewer) => void) {
    Object.values(this.#viewers).forEach(act);
  }

  /** The model's bytes, read once and shared by every stage that shows it. */
  load = () => {
    const requested = this.key;
    const { runId, toolId, connectionId, file } = this.#source();
    const read = () =>
      readToolOutputModel(runId, toolId, file.index, this.format, connectionId).catch((cause) => {
        if (modelFromAnotherComputer(connectionId)) this.#viewsFor = requested;
        throw cause;
      });
    return this.kept ? models.get(requested, read) : read();
  };

  loadViews = () => {
    const requested = this.key;
    // The expanded stage shows what the inline one already has or awaits.
    if (requested === this.#viewsKey && this.views.phase !== 'failed') return;
    if (requested !== this.#viewsKey) this.turn = 0;
    this.#viewsKey = requested;
    this.views = { phase: 'loading' };
    const { runId, toolId, connectionId, file } = this.#source();
    modelViews
      .get(requested, () => readToolOutputModelViews(runId, toolId, file.index, connectionId))
      .then(
        (read) => {
          if (requested === this.key)
            this.views = { phase: 'ready', urls: read.views.map(toolOutputImageUrl) };
        },
        (cause) => {
          if (requested === this.key)
            this.views = {
              phase: 'failed',
              message: String(cause instanceof Error ? cause.message : cause),
            };
        },
      );
  };
  /**
   * Views are read once their stage comes near the screen, as a model is; the file viewer shows
   * its stage at once, even when the viewer stepped to a model far from the chat's view.
   */
  viewsStage = (stage: HTMLElement, place: ModelPlace) => {
    if (place === 'inline') return { destroy: whenNear(stage, this.loadViews) };
    this.loadViews();
  };

  /** Turns through the drawn views as the reader asked, which a comparison passes on. */
  #turnTo(turn: number) {
    this.turn = ((turn % modelViewCount) + modelViewCount) % modelViewCount;
    this.#hooks.turned?.(this.turn);
  }
  step = (by: number) => this.#turnTo(this.turn + by);
  /** Back to the first view, where the viewer's camera starts. */
  home = () => this.#turnTo(0);
  /** Shows the view another model of a comparison turned to. */
  follow(turn: number) {
    this.turn = ((turn % modelViewCount) + modelViewCount) % modelViewCount;
  }
  turnKeys = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => this.step(-1),
      ArrowDown: () => this.step(-1),
      ArrowRight: () => this.step(1),
      ArrowUp: () => this.step(1),
      Home: this.home,
      End: () => this.#turnTo(modelViewCount - 1),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };
  /** A horizontal drag turns through the views as it turns the 3D viewer; a vertical one scrolls. */
  grab = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    const span = Math.min(64, Math.max(24, target.clientWidth / modelViewCount));
    let from = event.clientX;
    target.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => {
      const steps = Math.trunc((next.clientX - from) / span);
      if (!steps) return;
      this.step(steps);
      from += steps * span;
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  /** Each stage builds its scene through a viewer that keeps it only while it is on screen. */
  scene = (stage: HTMLElement, place: ModelPlace) => {
    this.statuses[place] = undefined;
    if (place === 'inline') {
      this.clips = [];
      this.clip = 0;
    }
    const created = createModelViewer(stage, {
      label: `3D model ${this.name}`,
      load: this.load,
      readAhead: this.kept,
      chat: place === 'inline',
      clip: () => this.clip,
      playing: () => this.playing,
      lighting: () => modelLighting.value,
      onStatus: (status) => {
        if (this.#viewers[place] !== created) return;
        this.statuses[place] = status;
        if (status.phase === 'ready') this.clips = status.clips;
      },
      onView: (view) => this.#hooks.moved?.(place, view),
    });
    this.#viewers[place] = created;
    if (place === 'inline' && this.#expanded) created.suspend(true);
    return {
      destroy: () => {
        created.destroy();
        if (this.#viewers[place] !== created) return;
        delete this.#viewers[place];
        this.statuses[place] = undefined;
      },
    };
  };

  play(next: number) {
    this.clip = next;
    this.playing = true;
    this.#each((viewer) => {
      viewer.setClip(next);
      viewer.setPlaying(true);
    });
  }
  setPlaying(playing: boolean) {
    this.playing = playing;
    this.#each((viewer) => viewer.setPlaying(playing));
  }
  toggle = () => this.setPlaying(!this.playing);
  zoom(place: ModelPlace, factor: number) {
    this.#viewers[place]?.zoom(factor);
  }
  reset(place: ModelPlace) {
    this.#viewers[place]?.reset();
  }
  retry(place: ModelPlace) {
    this.#viewers[place]?.retry();
  }
  /** Where the camera of the scene in `place` is, once it was built. */
  view(place: ModelPlace): CameraView | undefined {
    return this.#viewers[place]?.view();
  }
  /** Takes another model's view in `place`, without reporting it. */
  setView(place: ModelPlace, view: CameraView) {
    this.#viewers[place]?.setView(view);
  }
  /**
   * The inline stage keeps its place in the chat while the file viewer shows the model, so the
   * reading position holds and focus returns to Expand on close; it only gives up its scene.
   */
  shown = (showing: boolean) => {
    this.#expanded = showing;
    this.#viewers.inline?.suspend(showing);
  };
}
