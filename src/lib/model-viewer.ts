/**
 * Keeps a shown model's 3D scene only while its stage is on screen or was just there.
 *
 * Browsers keep about sixteen WebGL contexts per page and silently drop the oldest past that,
 * and one reply alone can show 96 models, so a window holds at most `MAX_SCENES`. A scene out
 * of view for `RELEASE_AFTER` gives its context back, keeping its camera and animation time for
 * when it returns, and a new scene past the limit takes the place of the one out of view
 * longest. Each scene draws on a canvas of its own, since a released context cannot draw
 * again. A model's bytes are read when its stage comes near the screen, not when the reply
 * opens, and a scene is built once the stage has stayed on screen briefly, so scrolling past
 * a group builds nothing.
 */
import {
  createModelScene,
  describeModelFault,
  type ModelFormat,
  type ModelScene,
  type SceneState,
} from './model-scene';

export const MAX_SCENES = 8;
const RELEASE_AFTER = 10_000;
const SETTLE = 150;
/** Contexts the browser may drop before a stage stops building its scene again by itself. */
const LOSSES = 2;

export type Place = {
  onScreen(): boolean;
  /** When the stage last came into or left view; the one out of view longest gives way first. */
  seenAt(): number;
  release(): void;
  wake(): void;
};
/** The scenes a window keeps, as places handed out in turn. */
export function createScenePlaces(size: number) {
  const held = new Set<Place>();
  const waiting = new Set<Place>();
  return {
    /**
     * Takes a place, releasing the scene out of view longest when all are taken. With every
     * held scene on screen, the place waits and is woken when one is given back.
     */
    take(place: Place): boolean {
      if (held.has(place)) return true;
      if (held.size >= size) {
        const idle = [...held]
          .filter((other) => !other.onScreen())
          .sort((a, b) => a.seenAt() - b.seenAt())[0];
        if (idle) {
          held.delete(idle);
          idle.release();
        }
      }
      if (held.size >= size) {
        waiting.add(place);
        return false;
      }
      waiting.delete(place);
      held.add(place);
      return true;
    },
    give(place: Place) {
      waiting.delete(place);
      if (!held.delete(place)) return;
      const next = waiting.values().next();
      if (!next.done) {
        waiting.delete(next.value);
        next.value.wake();
      }
    },
    get held() {
      return held.size;
    },
  };
}
const places = createScenePlaces(MAX_SCENES);

/** The nearest ancestor that scrolls, which bounds what an observer of the stage can see. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}
/**
 * Calls `near` once, when `stage` comes within 600 px of view. The margin is measured from the
 * chat's own scroller: seen from the window, that scroller hides the stage however wide the
 * margin. Returns what stops watching.
 */
export function whenNear(stage: HTMLElement, near: () => void): () => void {
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      near();
    },
    { root: scroller(stage), rootMargin: '600px 0px' },
  );
  observer.observe(stage);
  return () => observer.disconnect();
}

export type ViewerStatus = {
  phase: 'loading' | 'ready' | 'failed';
  message: string;
  clips: string[];
};
export type ModelViewer = {
  setClip(clip: number): void;
  setPlaying(playing: boolean): void;
  zoom(factor: number): void;
  reset(): void;
  retry(): void;
  /** A suspended stage keeps no scene, as the inline one while the expanded view is open. */
  suspend(suspended: boolean): void;
  destroy(): void;
};

export function createModelViewer(
  stage: HTMLElement,
  options: {
    /** The canvas's accessible name. */
    label: string;
    /** The model's bytes, read once and shared by every stage that shows it. */
    load(): Promise<{ format: ModelFormat; bytes: ArrayBuffer }>;
    /**
     * Whether to read the bytes ahead, as the stage nears the screen. A model too large to
     * keep between reads is read only when its scene is built.
     */
    readAhead: boolean;
    wheelZoom: boolean;
    clip(): number;
    playing(): boolean;
    onStatus(status: ViewerStatus): void;
  },
): ModelViewer {
  let scene: ModelScene | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let building = false;
  let destroyed = false;
  let suspended = false;
  let onScreen = false;
  let seenAt = 0;
  let saved: SceneState | undefined;
  let losses = 0;
  let clips: string[] = [];
  let settle: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const report = (phase: ViewerStatus['phase'], message = '') =>
    options.onStatus({ phase, message, clips });
  const place: Place = {
    onScreen: () => onScreen && !suspended,
    seenAt: () => seenAt,
    release: () => release(true),
    wake: () => schedule(0),
  };
  const sizes = new ResizeObserver(() => scene?.resize());

  function schedule(delay = SETTLE) {
    clearTimeout(settle);
    settle = setTimeout(() => void build(), delay);
  }
  async function build() {
    if (destroyed || suspended || !onScreen || scene || building) return;
    report('loading');
    if (!places.take(place)) return;
    building = true;
    let model: { format: ModelFormat; bytes: ArrayBuffer };
    try {
      model = await options.load();
    } catch (cause) {
      building = false;
      places.give(place);
      if (!destroyed) report('failed', String(cause instanceof Error ? cause.message : cause));
      return;
    }
    if (destroyed || suspended || !onScreen) {
      building = false;
      places.give(place);
      return;
    }
    const element = document.createElement('canvas');
    element.className = 'model-canvas';
    element.tabIndex = 0;
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', options.label);
    element.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown + - Home');
    // Laid out so the scene can size itself, but shown only once it draws, with its controls'
    // touch and wheel rules in place.
    element.style.visibility = 'hidden';
    stage.append(element);
    let created: ModelScene;
    try {
      created = await createModelScene(element, model.bytes, model.format, {
        wheelZoom: options.wheelZoom,
        clip: options.clip(),
        playing: options.playing(),
        state: saved,
      });
    } catch (cause) {
      building = false;
      element.remove();
      places.give(place);
      if (!destroyed) report('failed', describeModelFault(cause));
      return;
    }
    building = false;
    if (destroyed || suspended) {
      created.dispose();
      element.remove();
      places.give(place);
      return;
    }
    scene = created;
    canvas = element;
    element.style.visibility = '';
    clips = created.clips;
    element.addEventListener('webglcontextlost', lost);
    element.addEventListener('keydown', keys);
    sizes.observe(element);
    report('ready');
    if (!onScreen) away();
  }
  /** Frees the scene and its context, keeping where it was when `keep` is set. */
  function release(keep: boolean) {
    clearTimeout(idle);
    if (!scene || !canvas) return;
    if (keep) saved = scene.state();
    const [released, element] = [scene, canvas];
    scene = undefined;
    canvas = undefined;
    element.removeEventListener('webglcontextlost', lost);
    element.removeEventListener('keydown', keys);
    sizes.unobserve(element);
    released.dispose();
    element.remove();
    places.give(place);
  }
  /** The browser took the context back, as it does past its limit or after a GPU reset. */
  function lost() {
    if (!scene) return;
    losses++;
    release(true);
    if (losses > LOSSES)
      report('failed', 'The graphics device stopped drawing this 3D view to save memory.');
    else if (onScreen) schedule(1000);
  }
  function away() {
    scene?.setVisible(false);
    clearTimeout(idle);
    idle = setTimeout(() => release(true), RELEASE_AFTER);
  }
  function keys(event: KeyboardEvent) {
    if (!scene || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 0.35 : 0.12;
    const current = scene;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => current.orbit(-step, 0),
      ArrowRight: () => current.orbit(step, 0),
      ArrowUp: () => current.orbit(0, step),
      ArrowDown: () => current.orbit(0, -step),
      '+': () => current.zoom(0.8),
      '=': () => current.zoom(0.8),
      '-': () => current.zoom(1.25),
      Home: () => current.reset(),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  const visible = new IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry || destroyed) return;
    onScreen = entry.isIntersecting;
    seenAt = performance.now();
    if (onScreen) {
      clearTimeout(idle);
      if (scene) scene.setVisible(true);
      else schedule();
    } else {
      clearTimeout(settle);
      if (scene) away();
    }
  });
  visible.observe(stage);
  // The bytes are read ahead of the stage reaching the screen, once.
  const stopReading = options.readAhead
    ? whenNear(stage, () => void options.load().catch(() => {}))
    : () => {};

  return {
    setClip: (clip) => scene?.setClip(clip),
    setPlaying: (playing) => scene?.setPlaying(playing),
    zoom: (factor) => scene?.zoom(factor),
    reset: () => scene?.reset(),
    retry() {
      losses = 0;
      report('loading');
      schedule(0);
    },
    suspend(next) {
      suspended = next;
      if (next) {
        clearTimeout(settle);
        release(true);
      } else if (onScreen) schedule(0);
    },
    destroy() {
      destroyed = true;
      clearTimeout(settle);
      visible.disconnect();
      stopReading();
      release(false);
      sizes.disconnect();
      places.give(place);
    },
  };
}
