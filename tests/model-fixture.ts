/**
 * Minimal GLBs, built here so no binary asset lives in the repository: one triangle with a
 * rotation clip, and one wearing an embedded PNG, enough for a real three.js parse in the
 * browser. The textured one exists because an untextured model cannot notice a policy that
 * blocks the blob: URLs three.js loads embedded images through.
 */

/** Wraps a glTF document and its binary chunk in the GLB container. */
function glbContainer(json: string, binary: Uint8Array): Uint8Array {
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

/** One triangle, turning through its 'Spin' clip unless `animated` is off. */
export function triangleGlb({ animated = true } = {}): Uint8Array {
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
    animations: animated
      ? [
          {
            name: 'Spin',
            samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }],
            channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
          },
        ]
      : undefined,
  });
  return glbContainer(json, binary);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes: Uint8Array) => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
};

/**
 * An 8-bit RGB PNG. The pixel data goes into a single stored deflate block, so this needs no
 * compressor and stays small enough to read.
 */
export function rgbPng(
  width: number,
  height: number,
  texel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(texel(x, y), y * stride + 1 + x * 3);
  }
  if (raw.byteLength > 0xffff) throw new Error('rgbPng: one stored block holds 65535 bytes');
  const zlib = new Uint8Array(2 + 5 + raw.byteLength + 4);
  const stream = new DataView(zlib.buffer);
  zlib[0] = 0x78; // deflate, 32 KiB window
  zlib[1] = 0x01; // no preset dictionary, fastest
  zlib[2] = 0x01; // final stored block
  stream.setUint16(3, raw.byteLength, true);
  stream.setUint16(5, ~raw.byteLength & 0xffff, true);
  zlib.set(raw, 7);
  stream.setUint32(7 + raw.byteLength, adler32(raw));
  const header = new Uint8Array(13);
  const head = new DataView(header.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.byteLength;
  }
  return png;
}

/** The four texels of the textured fixture, in the order glTF reads them. */
export const texturedGlbTexels: [number, number, number][] = [
  [255, 0, 255], // magenta
  [255, 235, 0], // yellow
  [0, 210, 255], // cyan
  [120, 0, 255], // violet
];

/**
 * A triangle whose base colour comes from a 2×2 PNG held inside the file, with the rotation
 * clip of the plain one. Nothing beside the GLB is named, so a viewer that reaches for no
 * external file still has to show this texture.
 */
export function texturedGlb(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 0, 0]);
  const times = new Float32Array([0, 1]);
  const rotations = new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]);
  const png = rgbPng(2, 2, (x, y) => texturedGlbTexels[y * 2 + x]);
  const align = (n: number) => Math.ceil(n / 4) * 4;
  const offsets = {
    positions: 0,
    uvs: align(positions.byteLength),
    times: align(positions.byteLength) + align(uvs.byteLength),
    rotations: align(positions.byteLength) + align(uvs.byteLength) + align(times.byteLength),
  };
  const pngAt = align(offsets.rotations + rotations.byteLength);
  const binary = new Uint8Array(pngAt + png.byteLength);
  binary.set(new Uint8Array(positions.buffer), offsets.positions);
  binary.set(new Uint8Array(uvs.buffer), offsets.uvs);
  binary.set(new Uint8Array(times.buffer), offsets.times);
  binary.set(new Uint8Array(rotations.buffer), offsets.rotations);
  binary.set(png, pngAt);
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'TexturedTriangle' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [
      {
        name: 'Painted',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    // NEAREST both ways, so four texels stay four flat squares.
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: 4, mimeType: 'image/png', name: 'painted' }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets.positions, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets.uvs, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: offsets.times, byteLength: times.byteLength },
      { buffer: 0, byteOffset: offsets.rotations, byteLength: rotations.byteLength },
      { buffer: 0, byteOffset: pngAt, byteLength: png.byteLength },
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
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    animations: [
      {
        name: 'Spin',
        samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      },
    ],
  });
  return glbContainer(json, binary);
}

export const triangleGlbBase64 = (options?: { animated?: boolean }) =>
  Buffer.from(triangleGlb(options)).toString('base64');
export const texturedGlbBase64 = () => Buffer.from(texturedGlb()).toString('base64');
