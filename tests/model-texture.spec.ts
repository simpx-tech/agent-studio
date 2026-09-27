import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { texturedGlb, texturedGlbBase64 } from './model-fixture';

/**
 * A sent model wears the texture inside its own file. three.js hands an embedded glTF image
 * to the image loader as a blob: object URL and fetches it, so the viewer needs blob: in
 * connect-src and img-src; without it three drops the texture, keeps the geometry and logs
 * only to the console, which is how every model came out flat grey once.
 *
 * The first test drives the real viewer, and so covers the loader and the URL modifier it
 * parses under. The second runs the same module under the policy the app actually ships,
 * read from src-tauri/tauri.conf.json, because the dev server applies no policy of its own.
 * src/lib/csp.test.ts guards each declared policy on its own.
 */
const modelBytes = texturedGlb().byteLength;

test('a sent model keeps the texture embedded in it', async ({ page }) => {
  const glb = texturedGlbBase64();
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    ({ data, bytes }) => {
      (window as any).toolOutputs = { toolu_07: { models: [{ format: 'glb', data, bytes }] } };
    },
    { data: glb, bytes: modelBytes },
  );
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Show me the painted triangle');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate((bytes) => {
    const w = window as any;
    const runId = Object.keys(w.capabilityRuns)[0];
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: {
        id: 'painted',
        revision: 1,
        runId,
        toolId: 'toolu_07',
        caption: 'Four texels',
        files: [{ index: 0, name: 'painted.glb', mediaType: 'model/gltf-binary', bytes }],
      },
    });
    w.emitCapability({ kind: 'text', text: 'Here it is.\n\n<!-- files:painted -->' });
    w.finishCapabilities('complete');
  }, modelBytes);

  const reply = page.locator('.message:not(.user)');
  const canvas = reply.getByLabel('3D model painted.glb');
  await expect(canvas).toBeVisible();
  // The clip is proof the viewer parsed this GLB rather than falling back to a placeholder.
  await expect(reply.getByRole('button', { name: 'Pause animation' })).toBeVisible();
  await expect(reply.locator('.model-note.failed')).toHaveCount(0);
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(100);
  expect(problems.filter((text) => /load texture|Couldn't load/i.test(text))).toEqual([]);
});

test('the shipped policy lets an embedded model texture through', async ({ page }) => {
  const security = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security;
  // The dev server serves the module graph over http, which Tauri serves from the app itself,
  // so connect-src gains 'self' here. Nothing else is relaxed: blob: is never 'self'.
  const csp = security.csp.replace(/connect-src /, "connect-src 'self' ");
  expect(csp).not.toBe(security.csp);

  await page.route('**/texture-probe.html', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-security-policy': csp },
      body: '<!doctype html><html><head><title>probe</title></head><body><script type="module" src="/texture-probe.js"></script></body></html>',
    }),
  );
  await page.route('**/texture-probe.js', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/javascript' },
      body: `
        const probe = { blobFetches: [], clips: null, error: null };
        window.probe = probe;
        const fetched = window.fetch;
        window.fetch = async (input, init) => {
          const url = String(input);
          if (!url.startsWith('blob:')) return fetched(input, init);
          try {
            const response = await fetched(input, init);
            probe.blobFetches.push({ ok: response.ok });
            return response;
          } catch (error) {
            probe.blobFetches.push({ ok: false, message: String(error) });
            throw error;
          }
        };
        try {
          const { createModelScene } = await import('/src/lib/model-scene.ts');
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          document.body.append(canvas);
          const bytes = Uint8Array.from(atob(${JSON.stringify(texturedGlbBase64())}), (c) => c.charCodeAt(0));
          const scene = await createModelScene(canvas, bytes.buffer, 'glb');
          probe.clips = scene.clips;
        } catch (error) {
          probe.error = String(error);
        }
        probe.done = true;
      `,
    }),
  );

  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto('/texture-probe.html');
  await page.waitForFunction(() => (window as any).probe?.done === true, undefined, {
    timeout: 20000,
  });
  const probe = await page.evaluate(() => (window as any).probe);

  expect(probe.error).toBeNull();
  expect(probe.clips).toEqual(['Spin']);
  // three fetches the embedded PNG as a blob: object URL; under a policy without blob: in
  // connect-src the fetch is refused and the model renders untextured.
  expect(probe.blobFetches.length).toBeGreaterThan(0);
  expect(probe.blobFetches.every((attempt: { ok: boolean }) => attempt.ok)).toBe(true);
  expect(problems.filter((text) => /Content Security Policy|load texture/i.test(text))).toEqual([]);
});
