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
import { engaged, takesWheel } from './wheel-focus';

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

/**
 * Where the camera stands and the point it looks at and turns around, in the frame every model is
 * placed in: centred, its longest side one unit. Two scenes with the same view show their models
 * from the same direction, distance and offset, whatever the models' own sizes.
 */
export type CameraView = {
  position: [number, number, number];
  target: [number, number, number];
};
/** Where the camera was and how far the animation had run, to build the scene again as it was. */
export type SceneState = CameraView & { time: number };
export type SceneOptions = {
  /**
   * The view stands in the chat: vertical swipes scroll the conversation, and the wheel zooms
   * only while focus is within the view's card, which a click on the view gives it (`takesWheel`).
   */
  chat?: boolean;
  clip?: number;
  playing?: boolean;
  lighting?: Lighting;
  /** The camera and animation time of an earlier scene of the same model. */
  state?: SceneState;
  /**
   * Called as the reader turns, moves or zooms the view, and as it glides after a drag, with
   * where the camera now is; never for a view taken with `setView` or when the scene is built.
   */
  onView?: (view: CameraView) => void;
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
  /** Moves the camera closer by `factor` below 1 and away above it, towards the middle of the view. */
  zoom(factor: number): void;
  /** Turns the camera around the model by these angles, in radians. */
  orbit(left: number, up: number): void;
  /** Moves the view by these shares of its width and height, right and up positive. */
  pan(right: number, up: number): void;
  reset(): void;
  resize(): void;
  state(): SceneState;
  /** Where the camera is now. */
  view(): CameraView;
  /** Moves the camera where another scene's is, at once, ending any glide of its own. */
  setView(view: CameraView): void;
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
/**
 * How close the camera may come to the point it looks at, in the frame every model is placed in
 * (its longest side one unit): a hundred-thousandth of the model fills the view, so a detail of
 * any size can be looked at. Past this the drawing's own precision shows.
 */
const CLOSEST = 1e-5;
/** How far it may go, in the model's reaches: the model is then a speck. */
const FARTHEST = 100;
/**
 * How far the point the view turns around may move from the model's centre, in its reaches, so
 * the reader can move freely around and beside the model, and Reset always finds it again.
 */
const ROAM = 50;
/** How long a double click takes the view to the point it lands on. */
const FLIGHT_MS = 360;

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
  // The right button, Shift (or Ctrl or Cmd) with the left one, and two fingers move the view,
  // far beyond the model if the reader wants, though never so far that Reset cannot find it.
  const roam = radius * ROAM;
  controls.maxTargetRadius = roam;
  controls.minDistance = CLOSEST;
  controls.maxDistance = radius * FARTHEST;
  // A pinch, or a drag with the middle button, zooms towards the point it began on. three.js
  // reads that point of a middle-button drag from the pointer's horizontal place twice.
  controls.zoomToCursor = true;
  const zoomStart = controls as unknown as {
    _handleMouseDownDolly?(event: MouseEvent): void;
    _updateZoomParameters?(x: number, y: number): void;
    _dollyStart?: { set(x: number, y: number): void };
  };
  if (zoomStart._handleMouseDownDolly && zoomStart._updateZoomParameters && zoomStart._dollyStart)
    zoomStart._handleMouseDownDolly = (event) => {
      zoomStart._updateZoomParameters!(event.clientX, event.clientY);
      zoomStart._dollyStart!.set(event.clientX, event.clientY);
    };
  // So does the move the controls still owe as the view glides: a drag past the edge would
  // otherwise hold the view there through the start of the drag back.
  const owed = (controls as unknown as { _panOffset?: Vector3 })._panOffset;
  const update = controls.update.bind(controls);
  controls.update = (time) => {
    const moved = update(time);
    owed?.add(controls.target).clampLength(0, roam).sub(controls.target);
    return moved;
  };
  // The wheel zooms towards the very point of the model under the pointer (`zoomAbout`), which
  // the wheel of the controls cannot find, so theirs never listens. The view in the chat leaves
  // vertical swipes to the conversation: a vertical swipe scrolls while a horizontal one turns
  // the model, and two fingers move and zoom it.
  const ownWheel = (controls as unknown as { _onMouseWheel?: EventListener })._onMouseWheel;
  if (ownWheel) canvas.removeEventListener('wheel', ownWheel);
  if (options.chat) canvas.style.touchAction = 'pan-y';
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

  // The point of the model under a pointer, read from the depth of the one pixel there, which the
  // GPU draws in a moment however many triangles the model has. Only the model is drawn, so the
  // unseen floor of the realistic light is never found.
  const pickTarget = new THREE.WebGLRenderTarget(1, 1);
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBDepthPacking,
    side: THREE.DoubleSide,
  });
  const pixel = new Uint8Array(4);
  const clearColor = new THREE.Color();
  function pick(clientX: number, clientY: number): Vector3 | undefined {
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    if (!(box.width > 0 && box.height > 0) || x < 0 || y < 0 || x > box.width || y > box.height)
      return undefined;
    const hidden = scene.children.filter((child) => child !== object.parent && child.visible);
    for (const child of hidden) child.visible = false;
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    renderer.getClearColor(clearColor);
    const alpha = renderer.getClearAlpha();
    scene.overrideMaterial = depthMaterial;
    camera.setViewOffset(box.width, box.height, x, y, 1, 1);
    try {
      renderer.setRenderTarget(pickTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pixel);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(clearColor, alpha);
      camera.clearViewOffset();
      scene.overrideMaterial = null;
      renderer.shadowMap.needsUpdate = shadows;
      for (const child of hidden) child.visible = true;
    }
    // Packed as three.js packs it, in 24 bits, and white where nothing was drawn.
    const depth =
      (pixel[0] / 255) * (255 / 256) +
      (pixel[1] / 255) * (255 / 256 / 256) +
      pixel[2] / 255 / 65536;
    if (depth >= 1 - 1 / 65536) return undefined;
    const at = new THREE.Vector3((x / box.width) * 2 - 1, 1 - (y / box.height) * 2, depth * 2 - 1);
    return at.unproject(camera);
  }
  /** Where the pointer's ray meets the plane facing the camera through the point it looks at. */
  function under(clientX: number, clientY: number): Vector3 {
    const box = canvas.getBoundingClientRect();
    const ray = new THREE.Vector3(
      ((clientX - box.left) / Math.max(1, box.width)) * 2 - 1,
      1 - ((clientY - box.top) / Math.max(1, box.height)) * 2,
      0.5,
    )
      .unproject(camera)
      .sub(camera.position)
      .normalize();
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const along = controls.target.clone().sub(camera.position).dot(forward);
    return camera.position.clone().addScaledVector(ray, along / Math.max(1e-9, ray.dot(forward)));
  }
  /**
   * Moves the camera and the point it turns around towards `point` by `factor` below 1, or away
   * above it, keeping that point where it is on screen: the detail under the pointer grows where
   * it stands, as an image does, and the camera never passes through it.
   */
  function zoomAbout(point: Vector3, factor: number) {
    const distance = camera.position.distanceTo(controls.target);
    const next = THREE.MathUtils.clamp(
      distance * factor,
      controls.minDistance,
      controls.maxDistance,
    );
    const scale = next / Math.max(distance, Number.MIN_VALUE);
    if (scale === 1) return;
    flight = undefined;
    const target = controls.target.clone().sub(point).multiplyScalar(scale).add(point);
    // Past the room the view may roam, it zooms towards the middle of the view instead.
    const about = target.length() > roam ? controls.target : point;
    camera.position.sub(about).multiplyScalar(scale).add(about);
    controls.target.sub(about).multiplyScalar(scale).add(about);
    controls.update();
  }
  // A wheel gesture zooms towards the point under the pointer where it began, found once: the
  // camera moves towards it, so that point stays where it is while the gesture lasts.
  let aim: { point: Vector3; x: number; y: number; at: number } | undefined;
  function wheel(event: WheelEvent) {
    if (options.chat && !takesWheel(event, engaged(canvas))) return;
    event.preventDefault();
    const now = performance.now();
    if (!aim || now - aim.at > 250 || Math.hypot(event.clientX - aim.x, event.clientY - aim.y) > 4)
      aim = {
        point: pick(event.clientX, event.clientY) ?? under(event.clientX, event.clientY),
        x: event.clientX,
        y: event.clientY,
        at: now,
      };
    aim.at = now;
    const page = canvas.clientHeight;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1);
    // A notch of a mouse wheel is about one step of the zoom buttons; a touchpad pinch follows
    // the fingers.
    zoomAbout(aim.point, Math.exp(pixels * (event.ctrlKey ? 0.01 : 0.0022)));
  }
  canvas.addEventListener('wheel', wheel, { passive: false });
  // A double click takes the view to the point it lands on, which the view then turns around,
  // and halves the distance to it.
  let flight:
    { from: [Vector3, Vector3]; to: [Vector3, Vector3]; start: number; ms: number } | undefined;
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function focus(event: MouseEvent) {
    const point = pick(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(0.5);
    offset.setLength(
      THREE.MathUtils.clamp(offset.length(), controls.minDistance, controls.maxDistance),
    );
    flight = {
      from: [camera.position.clone(), controls.target.clone()],
      to: [point.clone().add(offset), point],
      start: performance.now(),
      ms: reducedMotion() ? 0 : FLIGHT_MS,
    };
    request();
  }
  canvas.addEventListener('dblclick', focus);
  /** Moves the view along its flight, which the reader taking the view ends. */
  function fly(now: number) {
    if (!flight) return false;
    const t = flight.ms ? Math.min(1, (now - flight.start) / flight.ms) : 1;
    const eased = 1 - (1 - t) ** 3;
    camera.position.lerpVectors(flight.from[0], flight.to[0], eased);
    controls.target.lerpVectors(flight.from[1], flight.to[1], eased);
    if (t >= 1) flight = undefined;
    return true;
  }
  const grabbed = () => (flight = undefined);
  controls.addEventListener('start', grabbed);
  /**
   * The near and far planes follow the camera: near enough that a detail a hundred-thousandth of
   * the model stays whole in front of it, and no deeper than the scene, so surfaces never
   * flicker into one another however close the camera comes.
   */
  function fitPlanes() {
    const distance = camera.position.distanceTo(controls.target);
    const near = Math.min(0.01, Math.max(distance * 0.005, 1e-8));
    const far = camera.position.length() + radius * 12 + distance;
    if (near === camera.near && far === camera.far) return;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }

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
    const flying = fly(now);
    const moving = controls.update() || flying;
    fitPlanes();
    // The controls report no move smaller than their threshold, so a glide ends a little past the
    // view it last reported: the view it came to rest at is reported once more.
    if (!moving && leading) {
      leading = false;
      options.onView?.(view());
    }
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
  const view = (): CameraView => ({
    position: camera.position.toArray() as [number, number, number],
    target: controls.target.toArray() as [number, number, number],
  });
  // While the scene is built, and while it takes another scene's view, its camera moves without
  // the reader: those moves are not reported.
  let following = true;
  // Whether the reader moved the view since it last came to rest.
  let leading = false;
  function changed() {
    request();
    if (following) return;
    leading = true;
    options.onView?.(view());
  }
  controls.addEventListener('change', changed);

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
  following = false;
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
      zoomAbout(controls.target.clone(), factor);
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
      controls.target.add(move.applyQuaternion(camera.quaternion)).clampLength(0, roam);
      camera.position.copy(controls.target).add(offset);
      request();
    },
    reset() {
      flight = undefined;
      start();
      request();
    },
    resize,
    state: () => ({ ...view(), time: action?.time ?? 0 }),
    view,
    setView(next) {
      flight = undefined;
      following = true;
      // Without damping, one update spends what is left of a glide, which would otherwise carry
      // this view away from the one it follows.
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      camera.position.fromArray(next.position);
      controls.target.fromArray(next.target);
      // The controls take the new view as their own, so the next frame reports no move.
      controls.update();
      following = false;
      leading = false;
      request();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      controls.removeEventListener('change', changed);
      controls.removeEventListener('start', grabbed);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('dblclick', focus);
      controls.dispose();
      pickTarget.dispose();
      depthMaterial.dispose();
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
