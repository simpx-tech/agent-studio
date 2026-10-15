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
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Texture,
  ToneMapping,
  Vector3,
  WebGLRenderer,
} from 'three';
import { blobBase64 } from './images';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'fbx';

/**
 * How a model is lit. Studio is the even set of lights the viewer always had; Flat draws every
 * surface in its own colours, unlit, exactly as painted; Realistic sets the model in a room whose
 * light it takes and reflects, under a sun casting soft shadows on it and on the floor below.
 */
export type Lighting = 'studio' | 'flat' | 'realistic';
export const lightings: { id: Lighting; name: string }[] = [
  { id: 'studio', name: 'Studio' },
  { id: 'flat', name: 'Flat' },
  { id: 'realistic', name: 'Realistic' },
];
export const isLighting = (value: unknown): value is Lighting =>
  lightings.some((lighting) => lighting.id === value);

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
  lighting?: Lighting;
  /** The camera and animation time of an earlier scene of the same model. */
  state?: SceneState;
};
export type ModelScene = {
  /** Named animations inside the file, in their own order. */
  clips: string[];
  setClip(clip: number): void;
  /** Pausing holds the pose it reached; playing again continues from there. */
  setPlaying(playing: boolean): void;
  /** Lights the model anew; a scene out of view does so when it comes back. */
  setLighting(lighting: Lighting): void;
  /** Out of view the scene draws nothing, keeping its pose and animation time. */
  setVisible(visible: boolean): void;
  zoom(factor: number): void;
  /** Turns the camera around the model by these angles, in radians. */
  orbit(left: number, up: number): void;
  /** Moves the view by these shares of its width and height, right and up positive. */
  pan(right: number, up: number): void;
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
 * A small studio of lights, so a model looks the same on every computer and in every view and
 * needs no environment file. Physically based materials still read as rounded volumes.
 */
function studioLights(THREE: typeof import('three')): Group {
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xf2f4ff, 0x30302f, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-4, 1, -3);
  lights.add(fill);
  lights.add(new THREE.AmbientLight(0xffffff, 0.35));
  return lights;
}

/** Where a model stands once placed: how far it reaches from its centre, and its lowest height. */
type Placed = { radius: number; floor: number };

/**
 * Centres a model on the origin at a size the camera can frame. The camera frames its reach
 * whole, and the realistic light's floor lies under its lowest point.
 */
function place(THREE: typeof import('three'), scene: Scene, object: Object3D): Placed {
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
  const radius = Number.isFinite(reach) && reach > 0.05 ? reach : 0.5;
  const floor = -size.y / 2 / extent;
  return { radius, floor: Number.isFinite(floor) ? floor : -radius };
}

/** Each light's tone: Flat shows colours as painted, so it maps none. */
const TONES = (THREE: typeof import('three')): Record<Lighting, ToneMapping> => ({
  studio: THREE.ACESFilmicToneMapping,
  flat: THREE.NoToneMapping,
  realistic: THREE.NeutralToneMapping,
});
/** Where the realistic light's sun stands: high, to the left of the starting view. */
const SUN: [number, number, number] = [-1.3, 3.2, 1.6];
/** How strongly the room lights a model under the realistic light, and its sun. */
const ROOM_INTENSITY = 0.7;
const SUN_INTENSITY = 1.8;

/** The realistic light's room, sun and the floor its shadow falls on. */
type Rig = { lights: Group; environment: Texture; dispose(): void };
type RoomModule = typeof import('three/examples/jsm/environments/RoomEnvironment.js');

/** What the generator keeps between its steps, read to compile its filters ahead. */
type GeneratorParts = {
  _setSize?(cubeSize: number): void;
  _allocateTargets?(): import('three').WebGLRenderTarget;
  _ggxMaterial?: Material | null;
  _blurMaterial?: Material | null;
};

/**
 * The light of a generated room, as physically based materials take and reflect it. The
 * generator's filters are the slowest shaders three.js compiles, and the generator compiles them
 * the moment it runs, which held the window for half a second the first time. They and the
 * room's own shaders compile in the background first, as the generator draws them: into its
 * targets, where no tone mapping applies.
 */
async function roomLight(
  THREE: typeof import('three'),
  { RoomEnvironment }: RoomModule,
  renderer: WebGLRenderer,
): Promise<Texture> {
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    const parts = generator as unknown as GeneratorParts;
    if (parts._setSize && parts._allocateTargets) {
      // The size fromScene uses, so it keeps the filters compiled here.
      parts._setSize(256);
      const target = parts._allocateTargets();
      // A program is compiled for the geometry it draws: the filters draw planes with positions.
      const plane = new THREE.BufferGeometry();
      plane.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const filters = new THREE.Scene();
      for (const material of [parts._ggxMaterial, parts._blurMaterial])
        if (material) filters.add(new THREE.Mesh(plane, material));
      renderer.setRenderTarget(target);
      const compiled = Promise.all([
        renderer.compileAsync(room, new THREE.PerspectiveCamera(90, 1, 0.1, 100)),
        renderer.compileAsync(filters, new THREE.OrthographicCamera()),
      ]);
      renderer.setRenderTarget(null);
      await compiled.catch(() => {});
      target.dispose();
      plane.dispose();
    }
    return generator.fromScene(room, 0.04).texture;
  } finally {
    room.dispose();
    generator.dispose();
  }
}

/**
 * Builds the realistic light around a placed model: the light of a room, which physically based
 * materials take and reflect, and a sun whose soft shadow falls on the model and on an unseen
 * floor under its lowest point. The room is generated, so nothing is fetched.
 */
async function realisticRig(
  THREE: typeof import('three'),
  room: RoomModule,
  renderer: WebGLRenderer,
  { radius, floor }: Placed,
): Promise<Rig> {
  const environment = await roomLight(THREE, room, renderer);

  const lights = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  sun.position.set(...SUN).setLength(radius * 4);
  sun.castShadow = true;
  const shadow = sun.shadow;
  // About a texel of shadow for each pixel the model spans, since a window holds up to eight
  // scenes: the model fits the narrower side of the canvas.
  const drawn = renderer.getDrawingBufferSize(new THREE.Vector2());
  const texels = THREE.MathUtils.ceilPowerOfTwo(Math.max(1, Math.min(drawn.x, drawn.y)));
  shadow.mapSize.setScalar(THREE.MathUtils.clamp(texels, 512, 2048));
  shadow.radius = 3;
  shadow.bias = -0.0004;
  shadow.normalBias = radius * 0.008;
  // The shadow camera looks along the sun, so the model's own reach is all its shadow covers.
  const view = shadow.camera as OrthographicCamera;
  view.left = view.bottom = -radius * 1.05;
  view.right = view.top = radius * 1.05;
  view.near = radius;
  view.far = radius * 9;
  view.updateProjectionMatrix();
  lights.add(sun);

  // The floor shows only the shadow on it, and hides nothing behind it.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 10, radius * 10),
    new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floor;
  ground.receiveShadow = true;
  lights.add(ground);
  return {
    lights,
    environment,
    dispose() {
      environment.dispose();
      sun.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

/** Material types lights shade, which flat light draws in their own colours instead. */
const shaded = (material: Material) => {
  const kind = material as unknown as Record<string, unknown>;
  return !!(
    kind.isMeshStandardMaterial ||
    kind.isMeshPhongMaterial ||
    kind.isMeshLambertMaterial ||
    kind.isMeshToonMaterial
  );
};

/**
 * The same surface unlit: its colour, texture, vertex colours, transparency and sides, drawn
 * as they are, without light or tone mapping. Textures stay shared with the shaded material.
 */
export function unlitMaterial(THREE: typeof import('three'), material: Material): Material {
  if (!shaded(material)) return material;
  // The fields read here exist on every shaded type.
  const from = material as MeshStandardMaterial;
  return new THREE.MeshBasicMaterial({
    name: from.name,
    color: from.color,
    map: from.map,
    alphaMap: from.alphaMap,
    alphaTest: from.alphaTest,
    alphaHash: from.alphaHash,
    alphaToCoverage: from.alphaToCoverage,
    transparent: from.transparent,
    opacity: from.opacity,
    side: from.side,
    vertexColors: from.vertexColors,
    blending: from.blending,
    depthTest: from.depthTest,
    depthWrite: from.depthWrite,
    wireframe: from.wireframe,
    visible: from.visible,
    toneMapped: false,
  });
}

/**
 * Lights a placed model the chosen way, keeping its own materials for Studio and Realistic and
 * unlit copies of them for Flat. The realistic room and sun are built, in the background, the
 * first time they are prepared. `dispose` frees what it built and gives each surface its own
 * material back.
 */
function createLights(
  THREE: typeof import('three'),
  room: RoomModule,
  renderer: WebGLRenderer,
  scene: Scene,
  object: Object3D,
  placed: Placed,
) {
  const studio = studioLights(THREE);
  scene.add(studio);
  scene.environmentIntensity = ROOM_INTENSITY;
  const tones = TONES(THREE);
  const surfaces: { mesh: Mesh; material: Material | Material[] }[] = [];
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    surfaces.push({ mesh, material: mesh.material });
    // Both sides of a surface cast the sun's shadow. three.js draws only a one-sided surface's
    // back into the shadow, so a plane, a card or an open mesh facing the sun cast none.
    for (const material of [mesh.material].flat()) material.shadowSide = THREE.DoubleSide;
  });
  const unlit = new Map<Material, Material>();
  const flat = (material: Material) => {
    let copy = unlit.get(material);
    if (!copy) unlit.set(material, (copy = unlitMaterial(THREE, material)));
    return copy;
  };
  let rig: Rig | undefined;
  let building: Promise<void> | undefined;
  let disposed = false;
  return {
    /** Builds what a light needs before it is applied; only the realistic one needs anything. */
    prepare(lighting: Lighting): Promise<void> {
      if (lighting !== 'realistic') return Promise.resolve();
      return (building ??= realisticRig(THREE, room, renderer, placed).then(
        (built) => {
          if (disposed) return built.dispose();
          rig = built;
          built.lights.visible = false;
          scene.add(built.lights);
        },
        // Without its room the realistic light keeps the studio one, as before it was chosen.
        () => {},
      ));
    },
    apply(chosen: Lighting) {
      const lighting = chosen === 'realistic' && !rig ? 'studio' : chosen;
      studio.visible = lighting === 'studio';
      if (rig) rig.lights.visible = lighting === 'realistic';
      scene.environment = lighting === 'realistic' && rig ? rig.environment : null;
      renderer.toneMapping = tones[lighting];
      for (const { mesh, material } of surfaces) {
        if (lighting !== 'flat') mesh.material = material;
        else mesh.material = Array.isArray(material) ? material.map(flat) : flat(material);
        mesh.castShadow = mesh.receiveShadow = lighting === 'realistic';
      }
    },
    dispose() {
      disposed = true;
      for (const { mesh, material } of surfaces) mesh.material = material;
      for (const [material, copy] of unlit) if (copy !== material) copy.dispose();
      rig?.dispose();
    },
  };
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
  const [{ OrbitControls }, room] = await Promise.all([
    import('three/examples/jsm/controls/OrbitControls.js'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
  ]);
  const object = await parse(THREE, bytes, format, surface(canvas));
  let renderer: WebGLRenderer;
  try {
    renderer = createRenderer(THREE, canvas);
  } catch (cause) {
    release(object);
    throw cause;
  }
  // Only the realistic sun casts a shadow; without it the shadow map draws nothing. The shadow
  // changes only with the model's pose or light, never as the view turns, so it is drawn again
  // only then.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const scene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const placed = place(THREE, scene, object);
  const { radius } = placed;
  const lights = createLights(THREE, room, renderer, scene, object, placed);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // The right button, Shift (or Ctrl or Cmd) with the left one, and two fingers move the view.
  // The point it turns around stays within the model's reach, so the model is never lost.
  controls.maxTargetRadius = radius;
  // So does the move the controls still owe as the view glides: a drag past the reach would
  // otherwise hold the view at the edge through the start of the drag back.
  const owed = (controls as unknown as { _panOffset?: Vector3 })._panOffset;
  const update = controls.update.bind(controls);
  controls.update = (time) => {
    const moved = update(time);
    owed?.add(controls.target).clampLength(0, radius).sub(controls.target);
    return moved;
  };
  controls.enableZoom = !!options.wheelZoom;
  if (!options.wheelZoom) {
    // The controls listen to the wheel without passive scrolling even with zoom off, and ask
    // for every touch. The inline view gives both back to the chat: the wheel scrolls past the
    // model, and a vertical swipe scrolls while a horizontal one turns it, or with two fingers
    // moves it.
    const wheel = (controls as unknown as { _onMouseWheel?: EventListener })._onMouseWheel;
    if (wheel) canvas.removeEventListener('wheel', wheel);
    canvas.style.touchAction = 'pan-y';
  }
  const direction = new THREE.Vector3(...START).normalize();
  const start = () => {
    // A turn or move still gliding would carry on from the start: without damping, one update
    // spends what is left of it.
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
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
  // The light asked for, and the one the scene is lit with; they differ while it is out of view.
  let lighting: Lighting = options.lighting ?? 'studio';
  let lit = lighting;
  // While a light is built and its shaders compile, the canvas keeps its last frame: drawing
  // then would wait for the compile instead. The first frame waits for the first light.
  let compiling = true;
  let compiles = 0;

  /** Lights the scene as last asked, once it is in view. */
  async function relight() {
    if (disposed || !visible || lit === lighting) return;
    const next = (lit = lighting);
    const turn = ++compiles;
    const current = () => turn === compiles && !disposed;
    compiling = true;
    await lights.prepare(next);
    if (!current()) return;
    lights.apply(next);
    renderer.shadowMap.needsUpdate = true;
    // Compiled in the background where the browser can, rather than in the next frame.
    await renderer.compileAsync(scene, camera).catch(() => {});
    if (!current()) return;
    compiling = false;
    previous = 0;
    request();
  }

  function render(now: number) {
    frame = 0;
    if (disposed || !visible || compiling) return;
    const moving = controls.update();
    if (!moving && playing && drawnAt && now - drawnAt < FRAME_MS) {
      request();
      return;
    }
    const seconds = previous ? Math.min((now - previous) / 1000, 0.25) : 0;
    previous = now;
    // A paused action still poses the model at its time.
    mixer?.update(playing ? seconds : 0);
    if (playing) renderer.shadowMap.needsUpdate = true;
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
    renderer.shadowMap.needsUpdate = true;
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
    renderer.shadowMap.needsUpdate = true;
  }
  if (mixer) {
    setClip(Math.min(Math.max(options.clip ?? 0, 0), clips.length - 1));
    if (options.state) resume(options.state.time);
    setPlaying(!!options.playing);
  }
  await lights.prepare(lit);
  lights.apply(lit);
  // Shaders compile in the background where the browser can, rather than in the first frame.
  await renderer.compileAsync(scene, camera).catch(() => {});
  compiling = false;
  request();

  return {
    clips: clips.map((clip, i) => clip.name?.trim() || `Clip ${i + 1}`),
    setClip,
    setPlaying,
    setLighting(next) {
      lighting = next;
      void relight();
    },
    setVisible(next) {
      visible = next;
      if (!next) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      previous = 0;
      void relight();
      request();
    },
    zoom(factor) {
      const offset = camera.position.clone().sub(controls.target);
      offset.multiplyScalar(factor).clampLength(0.35, 12);
      camera.position.copy(controls.target).add(offset);
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
    pan(right, up) {
      const offset = camera.position.clone().sub(controls.target);
      // How tall the view is where the camera looks, as dragging measures it.
      const height = 2 * offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const move = new THREE.Vector3(right * height * camera.aspect, up * height, 0);
      controls.target.add(move.applyQuaternion(camera.quaternion)).clampLength(0, radius);
      camera.position.copy(controls.target).add(offset);
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
      lights.dispose();
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
  // Views keep the studio light, whatever light the reader chose.
  scene.add(studioLights(THREE));
  const { radius } = place(THREE, scene, object);
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
  if (format === 'fbx') {
    // A texture on an FBX material's diffuse colour replaces that colour, as Blender and the
    // FBX SDK read it. three.js multiplies the two, and Blender writes 0.8 grey there, which
    // drew a textured export a fifth darker than painted.
    object.traverse((node) => {
      for (const material of materialsOf(node)) {
        const painted = material as Material & {
          color?: import('three').Color;
          map?: Texture | null;
        };
        if (painted.color && painted.map) painted.color.setRGB(1, 1, 1);
      }
    });
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
