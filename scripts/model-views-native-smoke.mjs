// Opt-in: a real Claude or Codex reply (MODEL_VIEWS_QA_PROVIDER, Claude by default) in an
// isolated native app sends a generated model of about 200 MB at full detail. The app's own
// window opens it whole in 3D, and a Viewer paired through a local relay sees the eight views
// that window draws of it, without the model crossing the relay. Build with
// scripts/native-model-views.tauri.json (after `npm run build`, which the relay's Viewer
// serves), then run this with the built executable. No credentials are copied. A rerun reuses
// the finished reply and the same relay, which the app stays paired with.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createRelay } from '../relay/server.ts';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.model-views-qa';
const port = Number(process.env.MODEL_VIEWS_QA_PORT ?? 19801);
const executable = resolve(
  process.env.MODEL_VIEWS_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const provider = process.env.MODEL_VIEWS_QA_PROVIDER ?? 'claude';
const data = join(process.env.LOCALAPPDATA, identifier);
const output = resolve('artifacts/model-views-qa');
// The model lives outside app data, which a packaged parent's shell may see redirected.
const folder = join(output, 'project');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(folder, { recursive: true });

/**
 * A torus knot tube with a colour per vertex, `segments` rings of `sides` vertices: 8192 × 512
 * makes about 8.4 million triangles and 208 MiB, far past what one relay request carries.
 */
function knotGlb(segments = 8192, sides = 512) {
  const count = segments * sides;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const indices = new Uint32Array(count * 6);
  const curve = (t) => {
    const r = 2 + Math.cos(3 * t);
    return [r * Math.cos(2 * t), r * Math.sin(2 * t), Math.sin(3 * t)];
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (a) => {
    const length = Math.hypot(...a) || 1;
    return [a[0] / length, a[1] / length, a[2] / length];
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const here = curve(t);
    const ahead = curve(t + 0.0005);
    const tangent = unit(sub(ahead, here));
    const binormal = unit(
      cross(tangent, [here[0] + ahead[0], here[1] + ahead[1], here[2] + ahead[2]]),
    );
    const normal = cross(binormal, tangent);
    // A hue that runs once around the knot, and bands that show the mesh's density up close.
    const hue = i / segments;
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const [a, b] = [-0.4 * Math.cos(v), 0.4 * Math.sin(v)];
      const offset = [
        a * normal[0] + b * binormal[0],
        a * normal[1] + b * binormal[1],
        a * normal[2] + b * binormal[2],
      ];
      const at = (i * sides + j) * 3;
      const direction = unit(offset);
      for (let k = 0; k < 3; k++) {
        positions[at + k] = here[k] + offset[k];
        normals[at + k] = direction[k];
        min[k] = Math.min(min[k], positions[at + k]);
        max[k] = Math.max(max[k], positions[at + k]);
      }
      const band = i % 64 < 32 !== j % 32 < 16 ? 1 : 0.8;
      const channel = (shift) =>
        Math.round(255 * band * (0.55 + 0.45 * Math.cos(2 * Math.PI * (hue + shift))));
      colors.set([channel(0), channel(1 / 3), channel(2 / 3), 255], (i * sides + j) * 4);
      const next = (i + 1) % segments;
      const [p, q, r, s] = [
        i * sides + j,
        next * sides + j,
        next * sides + ((j + 1) % sides),
        i * sides + ((j + 1) % sides),
      ];
      indices.set([p, q, s, q, r, s], (i * sides + j) * 6);
    }
  }
  const parts = [positions, normals, colors, indices].map((array) => new Uint8Array(array.buffer));
  const offsets = [];
  let length = 0;
  for (const part of parts) {
    offsets.push(length);
    length += Math.ceil(part.byteLength / 4) * 4;
  }
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'Agent Studio model views QA' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Knot' }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    materials: [
      { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.55 }, doubleSided: true },
    ],
    buffers: [{ byteLength: length }],
    bufferViews: parts.map((part, index) => ({
      buffer: 0,
      byteOffset: offsets[index],
      byteLength: part.byteLength,
      target: index === 3 ? 34963 : 34962,
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, normalized: true, count, type: 'VEC4' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
  });
  const text = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + length, 8);
  const chunk = (size, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(size, 0);
    head.write(type, 4, 'latin1');
    return head;
  };
  const binary = Buffer.alloc(length);
  parts.forEach((part, index) => binary.set(part, offsets[index]));
  return Buffer.concat([header, chunk(text.length, 'JSON'), text, chunk(length, 'BIN\0'), binary]);
}

function launch() {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-windows.ps1',
      '-Executable',
      executable,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
async function open() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(
        () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
      );
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
/** Types into a field the way a person does, so the page's own handlers see it. */
const fill = (page, label, value) =>
  page.evaluate(
    (label, value) => {
      const input = document.querySelector(`[aria-label="${label}"]`);
      if (!input) throw new Error(`Field unavailable: ${label}`);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
/** Whether `check` passes within `timeout`. */
async function within(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(250);
  }
  return false;
}
async function until(check, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, `${what} timed out`);
    await sleep(250);
  }
}

const model = join(folder, 'knot.glb');
await writeFile(model, knotGlb());
const size = (await stat(model)).size;
console.log(`model: ${(size / 1024 ** 2).toFixed(1)} MB`);

launch();
const page = await open();
await page.quitOnClose();
const report = { checkedAt: new Date().toISOString(), modelBytes: size };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
};
// The same relay on every run: the app keeps its pairing and joins no other workspace.
const relayData = join(output, 'relay-data');
await mkdir(relayData, { recursive: true });
const tokenFile = join(output, 'relay-token.txt');
const token = await readFile(tokenFile, 'utf8').catch(async () => {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await writeFile(tokenFile, token);
  return token;
});
const relay = createRelay({ token, directory: relayData, webDirectory: resolve('build') });
const relayPort = Number(process.env.MODEL_VIEWS_QA_RELAY_PORT ?? 19802);
await new Promise((ready) => relay.listen(relayPort, '127.0.0.1', ready));
const url = `http://127.0.0.1:${relay.address().port}`;
const viewer = await chromium.launch({ channel: 'msedge' });
try {
  const identity = await page.invoke('get_installation');
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Model views QA')),
    'Use only a disposable Model Views QA workspace.',
  );
  let account = workspace.fleet.accounts.find(
    (a) =>
      a.provider === provider &&
      workspace.fleet.connections.some(
        (c) => c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
      ),
  );
  if (!account) {
    account = { id: crypto.randomUUID(), provider, name: `Model views QA ${provider}` };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push({
      id: crypto.randomUUID(),
      accountId: account.id,
      environmentId: identity.id,
      profile: 'existing',
    });
  }
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.accountId === account.id && c.environmentId === identity.id && c.profile === 'existing',
  );
  const done = workspace.conversations.find((c) =>
    c.messages.at(-1)?.sentFiles?.some((g) => g.id === 'knot' && g.files[0]?.bytes === size),
  );
  const now = new Date().toISOString();
  const chat = done ?? {
    id: crypto.randomUUID(),
    title: `Model views QA ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider,
      // Each CLI's own default model, whichever that is today.
      model: provider === 'claude' ? 'sonnet' : '',
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  };
  if (!done) workspace.conversations.push(chat);
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.viewsReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.viewsReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  assert.equal(
    (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
    'ready',
  );
  await page.click('#conversation-tab-history');
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((e) =>
        e.textContent.includes(title),
      ),
    chat.title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  if (!done)
    await page.evaluate((text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, `This is a disposable test folder. Call the send_files tool exactly once, with id "knot", files ["${model}"] and caption "Full-detail torus knot". Do not open, convert, compress, reduce or otherwise change the file, and run nothing else. Then reply with one short sentence followed by the line <!-- files:knot --> on its own.`);
  if (!done) {
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
  }
  const answer = await until(
    async () => {
      const saved = await page.invoke('load_workspace');
      const last = saved.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      return last?.role === 'assistant' && last.status !== 'running' && last;
    },
    300_000,
    'reply',
  );
  const finished = Date.now();
  assert.equal(answer.status, 'complete', answer.error);
  const group = answer.sentFiles?.find((g) => g.id === 'knot');
  assert(group, 'the reply sent no files');
  assert.deepEqual(
    group.files.map((f) => [f.name, f.mediaType, f.bytes]),
    [['knot.glb', 'model/gltf-binary', size]],
  );
  report.reply = { runId: answer.runId, toolId: group.toolId };

  // This computer opens the whole model in 3D, read as raw bytes.
  await page.waitFor(() =>
    [...document.querySelectorAll('.model-canvas')].some(
      (c) =>
        c.getAttribute('aria-label') === '3D model knot.glb' && c.style.visibility !== 'hidden',
    ),
  );
  report.localSceneMs = Date.now() - finished;
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.model-note.failed').length),
    0,
  );
  await page.evaluate(() =>
    document.querySelector('.model-view')?.scrollIntoView({ block: 'center' }),
  );
  await sleep(500);
  await capture('local-model');
  report.rawRead = await page.evaluate(
    async (runId, toolId) => {
      const started = performance.now();
      const bytes = await window.__TAURI_INTERNALS__.invoke('read_tool_output_model_file', {
        runId,
        toolId,
        index: 0,
      });
      return { ms: Math.round(performance.now() - started), bytes: bytes.byteLength };
    },
    answer.runId,
    group.toolId,
  );
  assert.equal(report.rawRead.bytes, size);
  // Another device is told to use views instead of receiving it through the relay.
  const refused = await page.evaluate(
    async (runId, toolId) => {
      try {
        await window.__TAURI_INTERNALS__.invoke('read_tool_output_model', {
          runId,
          toolId,
          index: 0,
        });
        return 'read';
      } catch (error) {
        return String(error);
      }
    },
    answer.runId,
    group.toolId,
  );
  assert.match(refused, /another device reads whole/);

  // Pair the app with a local relay, which also serves the Viewer.
  await page.button('Connections');
  const synced = () => page.evaluate(() => /Synced /.test(document.body.innerText));
  if (!(await within(synced, 10_000))) {
    await page.button('Set up sync');
    await fill(page, 'Relay URL', url);
    await fill(page, 'Relay pairing key', token);
    await page.button('Pair & sync');
    await until(synced, 30_000, 'pairing');
  }
  const source = crypto.randomUUID();
  const call = async (method, path, body) => {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': source,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const views = async () => {
    const id = crypto.randomUUID();
    const started = Date.now();
    await call('POST', 'jobs', {
      id,
      source,
      target: identity.id,
      method: 'toolOutputModelViews',
      args: { runId: answer.runId, toolId: group.toolId, index: 0, connectionId: connection.id },
    });
    const job = await until(
      async () => {
        const job = await call('GET', `jobs/${id}`);
        return !['queued', 'running'].includes(job.status) && job;
      },
      120_000,
      'views',
    );
    assert.equal(job.status, 'complete', job.error);
    return { ms: Date.now() - started, views: job.result.views };
  };
  const first = await views();
  const second = await views();
  assert.equal(first.views.length, 8);
  assert.deepEqual(second.views, first.views);
  report.views = {
    firstMs: first.ms,
    keptMs: second.ms,
    types: [...new Set(first.views.map((v) => v.mediaType))],
    sizes: first.views.map((v) => `${v.width}x${v.height} ${v.bytes}`),
  };
  for (const [index, view] of first.views.entries())
    await writeFile(join(output, `view-${index + 1}.webp`), Buffer.from(view.data, 'base64'));
  const call_ = join(data, 'tool-output', answer.runId);
  const calls = await readdir(call_);
  const kept = (
    await Promise.all(calls.filter((c) => c !== 'run.json').map((c) => readdir(join(call_, c))))
  ).flat();
  assert(kept.includes('model-0-views.json'), `views not kept: ${kept}`);
  assert.equal(kept.filter((f) => /^model-0-view-\d\.webp$/.test(f)).length, 8);

  // The Viewer shows the same chat with the views as a turntable.
  const browser = await viewer.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await browser.newPage();
  await tab.goto(url);
  await tab.getByLabel('Workspace key', { exact: true }).fill(token);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  const row = tab.getByText(chat.title).first();
  await row.waitFor({ state: 'attached', timeout: 30_000 });
  // A chat from an earlier run of this check waits in History.
  if (!(await row.isVisible())) await tab.getByRole('tab', { name: /^History/ }).click();
  await row.click();
  const turntable = tab.getByRole('slider', { name: 'Turn knot.glb' });
  await turntable.waitFor({ timeout: 60_000 });
  assert.equal(await turntable.getAttribute('aria-valuetext'), 'View 1 of 8');
  await turntable.scrollIntoViewIfNeeded();
  await tab.screenshot({ path: join(output, 'viewer-turntable.png') });
  await turntable.focus();
  await tab.keyboard.press('ArrowRight');
  await tab.keyboard.press('ArrowRight');
  assert.equal(await turntable.getAttribute('aria-valuetext'), 'View 3 of 8');
  await tab.getByRole('button', { name: 'Expand knot.glb' }).click();
  await tab.screenshot({ path: join(output, 'viewer-expanded.png') });
  report.viewer = 'turntable shown and turned';
  report.errors = page.errors;
  assert.deepEqual(page.errors, []);
  await writeFile(join(output, 'native-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await viewer.close();
  await page.button('Close window').catch(() => {});
  page.close();
  await new Promise((done) => relay.close(done));
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
