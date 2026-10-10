/**
 * The 3D scene behind a shown model. three.js and its loaders load only when a reply
 * actually shows a model, so the app's own startup carries none of it.
 *
 * Model files are data, not source: they are parsed here, never executed, and the loading
 * manager refuses every URL a file names, so a model can reach no file and no network.
 */
import type {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Material,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  WebGLRenderer,
} from 'three';
import { blobBase64 } from './images';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'fbx';

/**
 * Why a model would not open, as a sentence the reader can act on. The loaders that decode
 * a compressed glTF fetch their own decoder, which this viewer refuses, so three.js reports
 * the missing one by name; a sender is told the same thing when the file is offered
 * (`undecodable_extension` in src-tauri/src/tool_output.rs), and this covers a file that
 * arrived before that check or names a compression it does not list.
 */
export function describeModelFault(cause: unknown): string {
  const text = String((cause as Error)?.message ?? cause ?? '');
  const compression = /DRACOLoader/i.test(text)
    ? 'Draco compression'
    : /meshopt/i.test(text)
      ? 'meshopt compression'
      : /KTX2|basisu/i.test(text)
        ? 'Basis Universal textures'
        : '';
  if (compression) return `This model uses ${compression}, which the viewer cannot decode.`;
  if (/Legacy binary file|glTF versions >=2\.0/i.test(text))
    return 'This is a glTF 1.0 model, which the viewer cannot read. Export it as glTF 2.0.';
  if (/FBX version not supported/i.test(text))
    return 'This FBX file is older than version 7, which the viewer cannot read. Export it as FBX 2011 or later, or as glTF.';
  if (/Error creating WebGL context|WebGL 1 is not supported/i.test(text))
    return 'This device cannot draw 3D models here: WebGL 2 is unavailable.';
  return 'This model could not be opened.';
}

/** Where the camera was and how far the animation had run, to build the scene again as it was. */
export type SceneState = {
  position: [number, number, number];
  target: [number, number, number];
  time: number;
};
export type SceneOptions = {
  /** Wheel zoom, for the expanded view; the inline view leaves the wheel and swipes to the chat. */
  wheelZoom?: boolean;
  clip?: number;
  playing?: boolean;
  /** The camera and animation time of an earlier scene of the same model. */
  state?: SceneState;
};
export type ModelScene = {
  /** Named animations inside the file, in their own order. */
  clips: string[];
  setClip(clip: number): void;
  /** Pausing holds the pose it reached; playing again continues from there. */
  setPlaying(playing: boolean): void;
  /** Out of view the scene draws nothing, keeping its pose and animation time. */
  setVisible(visible: boolean): void;
  zoom(factor: number): void;
  /** Turns the camera around the model by these angles, in radians. */
  orbit(left: number, up: number): void;
  reset(): void;
  resize(): void;
  state(): SceneState;
  dispose(): void;
};

/** Loaded once per window, and only for a reply that shows a model; a failed load is tried again. */
let three: Promise<typeof import('three')> | undefined;
const modules = () =>
  (three ??= import('three').catch((cause) => {
    three = undefined;
    throw cause;
  }));

/** An animation alone draws at most 60 frames a second, whatever the display's rate. */
const FRAME_MS = 1000 / 60 - 1;
/** Where the camera starts: in front of the model, a little to its right and above it. */
const START: [number, number, number] = [0.9, 0.65, 1.6];

/** A renderer drawing on a transparent background with the viewer's tone. */
function createRenderer(
  THREE: typeof import('three'),
  canvas: HTMLCanvasElement,
  preserveDrawingBuffer = false,
): WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer,
  });
  renderer.setClearAlpha(0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
}

/**
 * Puts a model in a small studio of lights, centred on the origin at a size the camera can
 * frame, so it looks the same on every computer and in every view and needs no environment
 * file. Physically based materials still read as rounded volumes. Returns how far the scaled
 * model reaches from its centre, which the camera frames whole.
 */
function studio(THREE: typeof import('three'), scene: Scene, object: Object3D): number {
  scene.add(new THREE.HemisphereLight(0xf2f4ff, 0x30302f, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-4, 1, -3);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const root = new THREE.Group();
  root.add(object);
  scene.add(root);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z) || 1;
  object.position.sub(center);
  root.scale.setScalar(1 / extent);
  const reach = size.length() / 2 / extent;
  return Number.isFinite(reach) && reach > 0.05 ? reach : 0.5;
}

/**
 * The distance that fits a model reaching `radius` whole in the narrower of the camera's two
 * directions, so a wide model still fits a tall view.
 */
function fitDistance(THREE: typeof import('three'), camera: PerspectiveCamera, radius: number) {
  const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  return (radius / Math.sin(Math.min(vertical, horizontal))) * 1.05;
}

export async function createModelScene(
  canvas: HTMLCanvasElement,
  bytes: ArrayBuffer,
  format: ModelFormat,
  options: SceneOptions = {},
): Promise<ModelScene> {
  const THREE = await modules();
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  const object = await parse(THREE, bytes, format, surface(canvas));
  let renderer: WebGLRenderer;
  try {
    renderer = createRenderer(THREE, canvas);
  } catch (cause) {
    release(object);
    throw cause;
  }
  const scene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const radius = studio(THREE, scene, object);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.enableZoom = !!options.wheelZoom;
  if (!options.wheelZoom) {
    // The controls listen to the wheel without passive scrolling even with zoom off, and ask
    // for every touch. The inline view gives both back to the chat: the wheel scrolls past the
    // model, and a vertical swipe scrolls while a horizontal one turns it.
    const wheel = (controls as unknown as { _onMouseWheel?: EventListener })._onMouseWheel;
    if (wheel) canvas.removeEventListener('wheel', wheel);
    canvas.style.touchAction = 'pan-y';
  }
  const direction = new THREE.Vector3(...START).normalize();
  const start = () => {
    camera.position.copy(direction).multiplyScalar(fitDistance(THREE, camera, radius));
    controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    controls.update();
  };

  const clips: AnimationClip[] = object.animations ?? [];
  const mixer: AnimationMixer | null = clips.length ? new THREE.AnimationMixer(object) : null;
  let action: AnimationAction | null = null;
  let playing = false;
  let visible = true;
  let frame = 0;
  let disposed = false;
  let drawnAt = 0;
  // Animations advance by real elapsed time; three.Clock is deprecated.
  let previous = 0;

  function render(now: number) {
    frame = 0;
    if (disposed || !visible) return;
    const moving = controls.update();
    if (!moving && playing && drawnAt && now - drawnAt < FRAME_MS) {
      request();
      return;
    }
    const seconds = previous ? Math.min((now - previous) / 1000, 0.25) : 0;
    previous = now;
    // A paused action still poses the model at its time.
    mixer?.update(playing ? seconds : 0);
    renderer.render(scene, camera);
    drawnAt = now;
    // Keep drawing only while something moves: damping, or a playing animation.
    if (playing || moving) request();
  }
  function request() {
    if (!frame && !disposed && visible) frame = requestAnimationFrame(render);
  }
  controls.addEventListener('change', request);

  function resize() {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width === Math.round(width * ratio) && canvas.height === Math.round(height * ratio))
      return;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    request();
  }
  function setClip(index: number) {
    const clip = clips[index];
    if (!mixer || !clip || action?.getClip() === clip) return;
    action?.stop();
    action = mixer.clipAction(clip);
    action.play();
    action.paused = !playing;
    previous = 0;
    request();
  }
  function setPlaying(next: boolean) {
    playing = next && !!action;
    if (action) action.paused = !playing;
    previous = 0;
    request();
  }

  resize();
  start();
  if (options.state) {
    camera.position.fromArray(options.state.position);
    controls.target.fromArray(options.state.target);
    controls.update();
  }
  function resume(time: number) {
    if (action) action.time = time;
  }
  if (mixer) {
    setClip(Math.min(Math.max(options.clip ?? 0, 0), clips.length - 1));
    if (options.state) resume(options.state.time);
    setPlaying(!!options.playing);
  }
  // Shaders compile in the background where the browser can, rather than in the first frame.
  await renderer.compileAsync(scene, camera).catch(() => {});
  request();

  return {
    clips: clips.map((clip, i) => clip.name?.trim() || `Clip ${i + 1}`),
    setClip,
    setPlaying,
    setVisible(next) {
      visible = next;
      if (!next) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      previous = 0;
      request();
    },
    zoom(factor) {
      camera.position.multiplyScalar(factor).clampLength(0.35, 12);
      request();
    },
    orbit(left, up) {
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= left;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - up, 0.05, Math.PI - 0.05);
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      request();
    },
    reset() {
      start();
      request();
    },
    resize,
    state: () => ({
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      time: action?.time ?? 0,
    }),
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      controls.removeEventListener('change', request);
      controls.dispose();
      mixer?.stopAllAction();
      mixer?.uncacheRoot(object);
      release(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** A drawn view of a model, as the computer keeping the model hands it to other devices. */
export type ModelViewImage = {
  mediaType: 'image/png' | 'image/webp';
  data: string;
  bytes: number;
  width: number;
  height: number;
};
export type ViewOptions = {
  count: number;
  width: number;
  height: number;
};
/**
 * The grey of a model without colours of its own in its views, which other devices show on
 * either theme: between the dark and light themes' `--model-surface`.
 */
const VIEW_SURFACE = '#9a9ea8';

/**
 * Pictures of a model from `count` directions a turn apart around it, for devices that do not
 * read the model itself. The first is the viewer's starting view, and each next one turns the
 * model as dragging the viewer to the right does. An animated model holds the opening pose of
 * its first animation, as the viewer shows it before playing. Views are WebP where the engine
 * encodes it and PNG otherwise, on a transparent background.
 */
export async function renderModelViews(
  bytes: ArrayBuffer,
  format: ModelFormat,
  options: ViewOptions,
): Promise<ModelViewImage[]> {
  const THREE = await modules();
  const object = await parse(THREE, bytes, format, VIEW_SURFACE);
  const canvas = document.createElement('canvas');
  let renderer: WebGLRenderer;
  try {
    renderer = createRenderer(THREE, canvas, true);
  } catch (cause) {
    release(object);
    throw cause;
  }
  const scene: Scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, options.width / options.height, 0.01, 1000);
  const radius = studio(THREE, scene, object);
  const clips = object.animations ?? [];
  const mixer = clips.length ? new THREE.AnimationMixer(object) : null;
  if (mixer) {
    mixer.clipAction(clips[0]).play();
    mixer.update(0);
  }
  const up = new THREE.Vector3(0, 1, 0);
  const start = new THREE.Vector3(...START).normalize();
  const distance = fitDistance(THREE, camera, radius);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(options.width, options.height, false);
    const views: ModelViewImage[] = [];
    for (let view = 0; view < options.count; view++) {
      const turn = (-view * 2 * Math.PI) / options.count;
      camera.position.copy(start).applyAxisAngle(up, turn).multiplyScalar(distance);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      views.push(await encode(canvas, options.width, options.height));
    }
    return views;
  } finally {
    mixer?.stopAllAction();
    mixer?.uncacheRoot(object);
    release(scene);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/** The canvas as it was just drawn, as an image another device can show. */
async function encode(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<ModelViewImage> {
  // The canvas is read at once, before the next view is drawn on it.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  );
  if (!blob) throw new Error('This model could not be drawn as an image here.');
  const mediaType = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
  return { mediaType, data: await blobBase64(blob), bytes: blob.size, width, height };
}

/** The colour of a model that carries none, from the theme, so it reads on either background. */
function surface(canvas: HTMLCanvasElement): string {
  return getComputedStyle(canvas).getPropertyValue('--model-surface').trim() || '#b9bcc4';
}

type Surface = { geometry?: { dispose(): void }; material?: Material | Material[] };
const materialsOf = (node: Object3D) => [(node as Surface).material ?? []].flat();
const texturesOf = (material: Material) =>
  Object.entries(material).filter(([, value]) => (value as Texture | null)?.isTexture) as [
    string,
    Texture,
  ][];

/** Frees what a parsed model holds: geometry, materials, and their textures and bitmaps. */
function release(root: Object3D) {
  root.traverse((node) => {
    (node as Surface).geometry?.dispose();
    for (const material of materialsOf(node)) {
      for (const [, texture] of texturesOf(material)) {
        const image = texture.image as { close?: () => void } | null;
        if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close?.();
        texture.dispose();
      }
      material.dispose();
    }
  });
}

/**
 * Takes out textures that never arrived. A texture whose file is missing, refused or of an
 * unsupported type keeps an empty image, and three.js then multiplies the surface by black, so
 * a model with textures beside it would show black instead of untextured.
 */
function dropMissingTextures(root: Object3D) {
  const arrived = (image: unknown) =>
    !!image &&
    !(
      typeof HTMLImageElement !== 'undefined' &&
      image instanceof HTMLImageElement &&
      !(image.complete && image.naturalWidth > 0)
    );
  root.traverse((node) => {
    for (const material of materialsOf(node)) {
      for (const [name, texture] of texturesOf(material)) {
        if (arrived(texture.image)) continue;
        (material as unknown as Record<string, unknown>)[name] = null;
        texture.dispose();
        material.needsUpdate = true;
      }
    }
  });
}

/** Parses one model file. Nothing beside the file itself is ever fetched. */
async function parse(
  THREE: typeof import('three'),
  bytes: ArrayBuffer,
  format: ModelFormat,
  color: string,
): Promise<Object3D & { animations: AnimationClip[] }> {
  const manager = new THREE.LoadingManager();
  const blobs = new Set<string>();
  // A model may name textures or buffers beside it; none of them are sent, and the viewer
  // must not reach for them. Such a URL becomes an empty data: URL, which fails here without
  // a request: an empty string would be read as this page's own address. The two schemes that
  // survive carry the file's own bytes: three.js hands a glTF's embedded images to the image
  // loader as blob: object URLs, and a .gltf's inline ones as data:. Both are fetched, so
  // connect-src and img-src must allow them in every policy this viewer runs under, or three
  // drops the texture and a model is silently grey (src-tauri/tauri.conf.json, relay/web.ts;
  // covered by src/lib/csp.test.ts).
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:')) blobs.add(url);
    return url.startsWith('data:') || url.startsWith('blob:') ? url : 'data:,';
  });
  // Textures a loader starts in the background, as FBX does, arrive after it returns.
  let pending = 0;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const start = manager.itemStart;
  const end = manager.itemEnd;
  manager.itemStart = (url) => {
    pending++;
    start(url);
  };
  manager.itemEnd = (url) => {
    end(url);
    if (--pending === 0) settle();
  };
  const object = await load(THREE, manager, bytes, format, blobs);
  // However long they take: a texture still arriving is never dropped.
  if (pending > 0) await settled;
  // The images are decoded by now; three.js keeps them, not their object URLs.
  for (const url of blobs) URL.revokeObjectURL(url);
  dropMissingTextures(object);
  if (format === 'obj') {
    // OBJLoader dresses every mesh in white, which the light theme's background swallows.
    object.traverse((node) => {
      for (const material of materialsOf(node)) {
        const plain = material as Material & {
          color?: import('three').Color;
          map?: Texture | null;
        };
        if (plain.color && !plain.map && !plain.vertexColors) plain.color.set(color);
      }
    });
  }
  if (format === 'stl') {
    for (const material of materialsOf(object))
      (material as Material & { color: import('three').Color }).color.set(color);
  }
  return object;
}

async function load(
  THREE: typeof import('three'),
  manager: import('three').LoadingManager,
  bytes: ArrayBuffer,
  format: ModelFormat,
  blobs: Set<string>,
): Promise<Object3D & { animations: AnimationClip[] }> {
  const text = () => new TextDecoder().decode(bytes);
  if (format === 'glb' || format === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader(manager).parseAsync(format === 'glb' ? bytes : text(), '');
    const scene = gltf.scene as Object3D & { animations: AnimationClip[] };
    scene.animations = gltf.animations ?? [];
    return scene;
  }
  if (format === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    // FBXLoader makes an object URL for each embedded image and never revokes it, including
    // images no texture uses, so the synchronous parse records them to be revoked afterwards.
    const create = URL.createObjectURL;
    URL.createObjectURL = (source) => {
      const url = create.call(URL, source);
      blobs.add(url);
      return url;
    };
    try {
      return new FBXLoader(manager).parse(bytes, '') as Object3D & {
        animations: AnimationClip[];
      };
    } finally {
      URL.createObjectURL = create;
    }
  }
  if (format === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const group = new OBJLoader(manager).parse(text()) as Object3D & {
      animations: AnimationClip[];
    };
    group.animations = [];
    return group;
  }
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const geometry = new STLLoader(manager).parse(bytes);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.05 }),
  ) as unknown as Object3D & { animations: AnimationClip[] };
  mesh.animations = [];
  return mesh;
}
