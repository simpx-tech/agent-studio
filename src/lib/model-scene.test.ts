import { describe, expect, it } from 'vitest';
import { describeModelFault } from './model-scene.ts';

/**
 * The viewer parses the bytes it was given and fetches nothing, so it carries no Draco,
 * meshopt or Basis decoder: each of those loads its own decoder over the network. A model
 * compressed with one used to reach the reader as a box reading only "This model could not
 * be opened", which names nothing the sender or the reader can act on. The sender is now
 * refused when the file is offered (`undecodable_extension` in src-tauri/src/tool_output.rs);
 * this covers a file that arrived before that check, or one whose compression it does not
 * list, so the failure still says what is wrong.
 */
describe('describeModelFault', () => {
  it('names the compression three.js reports a missing decoder for', () => {
    expect(describeModelFault(new Error('THREE.GLTFLoader: No DRACOLoader instance provided.'))).toBe(
      'This model uses Draco compression, which the viewer cannot decode.',
    );
    expect(
      describeModelFault(new Error('THREE.GLTFLoader: No MeshoptDecoder instance provided.')),
    ).toBe('This model uses meshopt compression, which the viewer cannot decode.');
    expect(describeModelFault(new Error('THREE.GLTFLoader: No KTX2Loader instance provided.'))).toBe(
      'This model uses Basis Universal textures, which the viewer cannot decode.',
    );
  });

  it('falls back to the plain failure for anything else', () => {
    expect(describeModelFault(new Error('Unexpected end of JSON input'))).toBe(
      'This model could not be opened.',
    );
    expect(describeModelFault(undefined)).toBe('This model could not be opened.');
    expect(describeModelFault('some string')).toBe('This model could not be opened.');
  });
});
