/**
 * A minimal animated GLB, built here so no binary asset lives in the repository: one
 * triangle with a rotation clip, enough for a real three.js parse in the browser.
 */
export function triangleGlb(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const times = new Float32Array([0, 1]);
  const rotations = new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]);
  const binary = new Uint8Array(
    positions.byteLength + times.byteLength + rotations.byteLength, // 36 + 8 + 32
  );
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(times.buffer), positions.byteLength);
  binary.set(new Uint8Array(rotations.buffer), positions.byteLength + times.byteLength);
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Triangle' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 32 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    animations: [
      {
        name: 'Spin',
        samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      },
    ],
  });
  const pad = (bytes: Uint8Array, filler: number) => {
    const size = Math.ceil(bytes.byteLength / 4) * 4;
    const padded = new Uint8Array(size).fill(filler);
    padded.set(bytes);
    return padded;
  };
  const jsonChunk = pad(new TextEncoder().encode(json), 0x20);
  const binChunk = pad(binary, 0);
  const glb = new Uint8Array(12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonChunk, 20);
  const binHeader = 20 + jsonChunk.byteLength;
  view.setUint32(binHeader, binChunk.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // "BIN\0"
  glb.set(binChunk, binHeader + 8);
  return glb;
}

export const triangleGlbBase64 = () => Buffer.from(triangleGlb()).toString('base64');
