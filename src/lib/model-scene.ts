/**
 * The 3D scene behind a shown model. three.js and its loaders load only when a reply
 * actually shows a model, so the app's own startup carries none of it.
 *
 * Model files are data, not source: they are parsed here, never executed, and the loading
 * manager refuses every URL a file names, so a model can reach no file and no network.
 */
import type {
  AnimationAction,
  AnimationMixer,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'fbx';
export type ModelScene = {
  /** Named animations inside the file, in their own order. */
  clips: string[];
  play(clip: number | null): void;
  zoom(factor: number): void;
  reset(): void;
  resize(): void;
  dispose(): void;
};

/** Loaded once per window, and only for a reply that shows a model. */
let three: Promise<typeof import('three')> | undefined;
const modules = () => (three ??= import('three'));

export async function createModelScene(
  canvas: HTMLCanvasElement,
  bytes: ArrayBuffer,
  format: ModelFormat,
  options: { wheelZoom?: boolean } = {},
): Promise<ModelScene> {
  const THREE = await modules();
  const object = await parse(THREE, bytes, format);
  const renderer: WebGLRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setClearAlpha(0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  // A small studio of lights, so a model looks the same on every computer and needs no
  // environment file. Physically based materials still read as rounded volumes.
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
  // Centre the model on the origin and view it at a size the camera can frame.
  object.position.sub(center);
  root.scale.setScalar(1 / extent);

  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.enableZoom = !!options.wheelZoom;
  controls.target.set(0, 0, 0);
  const start = () => {
    camera.position.set(0.9, 0.65, 1.6);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  };
  start();

  const mixer: AnimationMixer | null = object.animations?.length
    ? new THREE.AnimationMixer(object)
    : null;
  let action: AnimationAction | null = null;
  let playing = false;
  let frame = 0;
  let disposed = false;
  // The renderer advances animations by real elapsed time; three.Clock is deprecated.
  let previous = 0;
  const delta = () => {
    const now = performance.now();
    const seconds = previous ? Math.min((now - previous) / 1000, 0.25) : 0;
    previous = now;
    return seconds;
  };

  function render() {
    frame = 0;
    if (disposed) return;
    const seconds = delta();
    if (mixer && playing) mixer.update(seconds);
    const moving = controls.update();
    renderer.render(scene, camera);
    // Keep drawing only while something moves: damping, or a playing animation.
    if (playing || moving) request();
  }
  function request() {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
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
  resize();

  return {
    clips: mixer ? object.animations.map((clip, i) => clip.name?.trim() || `Clip ${i + 1}`) : [],
    play(clip) {
      if (!mixer) return;
      action?.stop();
      action = null;
      playing = clip !== null;
      if (clip !== null && object.animations[clip]) {
        action = mixer.clipAction(object.animations[clip]);
        action.reset();
        action.play();
      }
      if (!playing) mixer.setTime(0);
      previous = 0;
      request();
    },
    zoom(factor) {
      camera.position.multiplyScalar(factor).clampLength(0.35, 12);
      request();
    },
    reset() {
      start();
      request();
    },
    resize,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      controls.removeEventListener('change', request);
      controls.dispose();
      mixer?.stopAllAction();
      scene.traverse((node: Object3D) => {
        const mesh = node as unknown as {
          geometry?: { dispose(): void };
          material?: { dispose(): void } | { dispose(): void }[];
        };
        mesh.geometry?.dispose();
        for (const material of [mesh.material].flat())
          if (material && 'dispose' in material) material.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** Parses one model file. Nothing beside the file itself is ever fetched. */
async function parse(
  THREE: typeof import('three'),
  bytes: ArrayBuffer,
  format: ModelFormat,
): Promise<Object3D & { animations: import('three').AnimationClip[] }> {
  const manager = new THREE.LoadingManager();
  // A model may name textures or buffers beside it; none of them are sent, and the viewer
  // must not reach for them. An unresolvable URL keeps the geometry and drops the texture.
  manager.setURLModifier((url) => (url.startsWith('data:') || url.startsWith('blob:') ? url : ''));
  const text = () => new TextDecoder().decode(bytes);
  if (format === 'glb' || format === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader(manager).parseAsync(format === 'glb' ? bytes : text(), '');
    const scene = gltf.scene as Object3D & { animations: import('three').AnimationClip[] };
    scene.animations = gltf.animations ?? [];
    return scene;
  }
  if (format === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    return new FBXLoader(manager).parse(bytes, '') as Object3D & {
      animations: import('three').AnimationClip[];
    };
  }
  if (format === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const group = new OBJLoader(manager).parse(text()) as Object3D & {
      animations: import('three').AnimationClip[];
    };
    group.animations = [];
    return group;
  }
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const geometry = new STLLoader(manager).parse(bytes);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xb9bcc4, roughness: 0.65, metalness: 0.05 }),
  ) as unknown as Object3D & { animations: import('three').AnimationClip[] };
  mesh.animations = [];
  return mesh;
}
