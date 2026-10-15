import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { describeModelFault, isLighting, lightings, unlitMaterial } from './model-scene.ts';

/**
 * The viewer parses the bytes it was given and fetches nothing, so it carries no Draco,
 * meshopt or Basis decoder: each of those loads its own decoder over the network. A model
 * compressed with one used to reach the reader as a box reading only "This model could not
 * be opened", which names nothing the sender or the reader can act on. The sender is now
 * refused when the file is offered (`undecodable_extension` in src-tauri/src/tool_output.rs);
 * this covers a file that arrived before that check, or one whose compression it does not
 * list, so the failure still says what is wrong. The messages are three.js r186's own.
 */
describe('describeModelFault', () => {
  it('names the compression three.js reports a missing decoder for', () => {
    expect(
      describeModelFault(new Error('THREE.GLTFLoader: No DRACOLoader instance provided.')),
    ).toBe('This model uses Draco compression, which the viewer cannot decode.');
    expect(
      describeModelFault(
        new Error(
          'THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files',
        ),
      ),
    ).toBe('This model uses meshopt compression, which the viewer cannot decode.');
    expect(
      describeModelFault(
        new Error('THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures'),
      ),
    ).toBe('This model uses Basis Universal textures, which the viewer cannot decode.');
  });

  it('names files from formats too old to read, and a device that cannot draw', () => {
    for (const message of [
      'THREE.GLTFLoader: Legacy binary file detected.',
      'THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.',
    ])
      expect(describeModelFault(new Error(message))).toBe(
        'This is a glTF 1.0 model, which the viewer cannot read. Export it as glTF 2.0.',
      );
    expect(
      describeModelFault(
        new Error('THREE.FBXLoader: FBX version not supported, FileVersion: 6100'),
      ),
    ).toBe(
      'This FBX file is older than version 7, which the viewer cannot read. Export it as FBX 2011 or later, or as glTF.',
    );
    expect(
      describeModelFault(new Error('THREE.WebGLRenderer: Error creating WebGL context.')),
    ).toBe('This device cannot draw 3D models here: WebGL 2 is unavailable.');
  });

  it('falls back to the plain failure for anything else', () => {
    expect(describeModelFault(new Error('Unexpected end of JSON input'))).toBe(
      'This model could not be opened.',
    );
    expect(describeModelFault(undefined)).toBe('This model could not be opened.');
    expect(describeModelFault('some string')).toBe('This model could not be opened.');
  });
});

/**
 * Flat light draws each surface in its own colours. Every shaded material gets an unlit copy
 * that keeps what decides those colours and the surface's shape on screen, and shares its
 * textures; materials that take no light already are drawn as they are.
 */
describe('unlitMaterial', () => {
  it('keeps the colours, textures, transparency and sides of a shaded surface', () => {
    const map = new THREE.Texture();
    const alphaMap = new THREE.Texture();
    const shaded = new THREE.MeshStandardMaterial({
      name: 'Painted',
      color: 0x336699,
      map,
      alphaMap,
      alphaTest: 0.5,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthWrite: false,
      metalness: 1,
      roughness: 0.2,
    });
    const flat = unlitMaterial(THREE, shaded) as THREE.MeshBasicMaterial;
    expect(flat).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(flat.color.getHex()).toBe(0x336699);
    // A colour of its own: the shaded material is drawn again when the light changes back.
    expect(flat.color).not.toBe(shaded.color);
    expect([flat.map, flat.alphaMap]).toEqual([map, alphaMap]);
    expect(flat).toMatchObject({
      name: 'Painted',
      alphaTest: 0.5,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthWrite: false,
      // Colours as painted: no tone mapping either.
      toneMapped: false,
    });
  });

  it('turns every shaded type flat and leaves unlit ones as they are', () => {
    for (const shaded of [
      new THREE.MeshPhongMaterial(),
      new THREE.MeshLambertMaterial(),
      new THREE.MeshToonMaterial(),
      new THREE.MeshPhysicalMaterial(),
    ])
      expect(unlitMaterial(THREE, shaded)).toBeInstanceOf(THREE.MeshBasicMaterial);
    for (const unlit of [
      new THREE.MeshBasicMaterial(),
      new THREE.LineBasicMaterial(),
      new THREE.PointsMaterial(),
      new THREE.MeshNormalMaterial(),
    ])
      expect(unlitMaterial(THREE, unlit)).toBe(unlit);
  });
});

describe('lightings', () => {
  it('offers Studio first, the light the viewer always had, and knows only its own', () => {
    expect(lightings.map((lighting) => lighting.name)).toEqual(['Studio', 'Flat', 'Realistic']);
    for (const { id } of lightings) expect(isLighting(id)).toBe(true);
    for (const other of ['', 'Flat', 'unlit', null, undefined, 1])
      expect(isLighting(other)).toBe(false);
  });
});
