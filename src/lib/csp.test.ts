import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { webViewerCsp } from '../../relay/web.ts';

/**
 * The model viewer shows a sent .glb by parsing the bytes it was given and reaching for
 * nothing else (src/lib/model-scene.ts). three.js still needs two URL schemes to hand a
 * glTF's own images to the image loader: it wraps an embedded image in a Blob and loads that
 * object URL, and a .gltf names inline ones as data:. Both go through `fetch` under
 * ImageBitmapLoader (connect-src) and through an <img> under the TextureLoader fallback
 * (img-src), and three swallows the failure — so a policy missing either scheme leaves every
 * model flat grey with nothing logged in the app. Keep both schemes in both directives.
 */
const schemes = ['blob:', 'data:'];
const directives = ['connect-src', 'img-src'];

/** The sources a policy applies to one directive, falling back to default-src as CSP does. */
function sources(policy: string, directive: string): string[] {
  const parts = policy.split(';').map((part) => part.trim());
  const named = (name: string) =>
    parts.find((part) => part === name || part.startsWith(`${name} `));
  const found = named(directive) ?? named('default-src');
  if (!found) return [];
  const [, ...rest] = found.split(/\s+/);
  return rest;
}

const tauriPolicies = (file: string): [string, string][] => {
  const security = JSON.parse(readFileSync(file, 'utf8'))?.app?.security ?? {};
  return (['csp', 'devCsp'] as const)
    .filter((key) => typeof security[key] === 'string')
    .map((key) => [`${file} ${key}`, security[key] as string]);
};

// Every policy a window running the viewer can be served under. The artifact sandbox
// (relay/artifact-preview.ts) is deliberately left out: it holds no model viewer and its
// `connect-src 'none'` is the point of it.
const policies: [string, string][] = [
  ...tauriPolicies('src-tauri/tauri.conf.json'),
  ...readdirSync('scripts')
    .filter((name) => /^native-.+\.tauri\.json$/.test(name))
    .flatMap((name) => tauriPolicies(join('scripts', name))),
  ['relay/web.ts webViewerCsp', webViewerCsp],
];

it('finds the app policy and every native harness policy', () => {
  expect(policies.map(([label]) => label)).toContain('src-tauri/tauri.conf.json csp');
  expect(policies.map(([label]) => label)).toContain('src-tauri/tauri.conf.json devCsp');
  // The harnesses that pin their own policy drifted from the app once; keep them counted.
  expect(policies.length).toBeGreaterThanOrEqual(10);
});

describe.each(policies)('%s', (_label, policy) => {
  it.each(directives)('lets an embedded model texture load through %s', (directive) => {
    const allowed = sources(policy, directive);
    expect(allowed.length, `${directive} has no sources`).toBeGreaterThan(0);
    for (const scheme of schemes) expect(allowed).toContain(scheme);
  });
});
