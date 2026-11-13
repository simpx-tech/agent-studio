// Opt-in: a real build of the app reads and saves its workspace and its sync checkpoint a few
// megabytes at a time (src-tauri/src/parts.rs, src/lib/saved-parts.ts), with files of any size.
// On 2026-11-13 a 465 MB workspace, loaded as one text and written back as one by the first save
// of every start, filled the page's memory, and the window loaded again in a loop.
//
//   npm run build
//   CARGO_TARGET_DIR=<scratch> npx tauri build --debug --no-bundle --config scripts/native-storage-parts.tauri.json
//   STORAGE_QA_EXECUTABLE=<long path of that agent-studio.exe> node scripts/storage-parts-native-smoke.mjs
//
// It writes a workspace of about 60 MB, or takes copies of real files (never the live ones):
//   STORAGE_QA_WORKSPACE=<workspace.json> STORAGE_QA_CHECKPOINT=<sync-state.json>
// with NODE_OPTIONS=--max-old-space-size=16000 for large ones. The QA identity is not paired, so
// the checkpoint is read and written through the app's commands alone. Delete the QA data folder
// afterwards when it held real chats.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.parts-qa';
const port = 19921;
const executable = resolve(
  process.env.STORAGE_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const data = join(process.env.LOCALAPPDATA, identifier);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mb = (n) => `${Math.round(n / 1048576)} MB`;
const started = Date.now();
const log = (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

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
const running = () =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'agent-studio.exe\'" | ForEach-Object { $_.ExecutablePath }',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .split(/\r?\n/)
    .some((path) => path.trim().toLowerCase() === executable.toLowerCase());
async function connect() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      // A workspace of hundreds of megabytes takes a while to read.
      const ready = Date.now() + 180_000;
      while (
        !(await page.evaluate(
          () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
        ))
      ) {
        const banner = await page.evaluate(
          () => document.querySelector('.error-banner')?.textContent ?? null,
        );
        assert.equal(banner, null);
        assert(Date.now() < ready, 'The workspace did not load.');
        await sleep(250);
      }
      return page;
    } catch (error) {
      if (Date.now() > deadline || /error-banner|did not load|null ==/.test(String(error)))
        throw error;
      await sleep(500);
    }
  }
}
async function close(page) {
  await page.button('Close window').catch(() => {});
  page.close();
  const deadline = Date.now() + 60_000;
  while (running()) {
    assert(Date.now() < deadline, 'The QA app did not close.');
    await sleep(500);
  }
}

// A workspace and a checkpoint large enough for several reads, unless real copies are given.
function written() {
  const chat = (n) => ({
    id: crypto.randomUUID(),
    title: `Storage QA ${n} é 😀`,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: `2026-11-13T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    // Half of them still Active, which a start moves to History and saves.
    ...(n % 2 ? { archived: true } : {}),
    location: { computerId: crypto.randomUUID(), environmentId: crypto.randomUUID(), path: '' },
    messages: Array.from({ length: 8 }, (_, m) => ({
      id: crypto.randomUUID(),
      role: m % 2 ? 'assistant' : 'user',
      blocks: [
        { type: 'markdown', text: `Message ${m} of chat ${n}. “${'lorem ipsum '.repeat(18_000)}”` },
      ],
      status: 'complete',
      createdAt: '2026-11-13T00:00:00.000Z',
    })),
  });
  const conversations = Array.from({ length: 36 }, (_, n) => chat(n));
  const workspace = {
    version: 3,
    preferences: { lastProvider: 'codex', modelByProvider: {}, reasoningByProvider: {} },
    fleet: { computers: [], environments: [], accounts: [], connections: [] },
    conversations,
  };
  const checkpoint = {
    url: 'https://relay.invalid',
    instanceId: 'storage-qa',
    base: { fleet: workspace.fleet, conversations },
    revisions: { revision: 1, metaRevision: 1, chats: {} },
  };
  return { workspace: JSON.stringify(workspace), checkpoint: JSON.stringify(checkpoint) };
}
const source = process.env.STORAGE_QA_WORKSPACE
  ? {
      workspace: readFileSync(process.env.STORAGE_QA_WORKSPACE),
      checkpoint: readFileSync(process.env.STORAGE_QA_CHECKPOINT),
    }
  : written();

// A conversation as text, without what a start of the app changes in it and with its fields in
// one order: the page writes a conversation it saves in its schema's order.
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
const settled = (conversation) => {
  const { archived, location, ...rest } = conversation;
  return JSON.stringify(sorted(rest));
};
// Assertion messages never print a conversation.
const same = (actual, wanted, label) => {
  if (actual !== wanted) assert.fail(`${label} differs`);
};
const chatsOf = (text, path) => {
  let value = JSON.parse(text);
  for (const key of path) value = value[key];
  return value;
};
const report = { checkedAt: new Date().toISOString(), executable };

// The first launch makes the QA identity's data folder, which this driver then writes into.
if (running()) throw new Error('The QA app is already running: close it first.');
if (!existsSync(join(data, 'installation.json'))) {
  launch();
  const first = await connect();
  await first.quitOnClose();
  await sleep(3000);
  await close(first);
}
writeFileSync(join(data, 'workspace.json'), source.workspace);
writeFileSync(join(data, 'sync-state.json'), source.checkpoint);
const before = chatsOf(source.workspace.toString('utf8'), ['conversations']);
const expected = new Map(before.map((c) => [c.id, settled(c)]));
const active = before.filter((c) => !c.archived).length;
log(
  `seeded ${before.length} conversations, ${active} of them Active: workspace ${mb(source.workspace.length)}, checkpoint ${mb(source.checkpoint.length)}`,
);

launch();
let page = await connect();
await page.quitOnClose();
const heap = async () => {
  await page.cdp('HeapProfiler.enable');
  await page.cdp('HeapProfiler.collectGarbage');
  return (await page.cdp('Runtime.getHeapUsage')).usedSize;
};
const banner = () =>
  page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null);
const saved = () => chatsOf(readFileSync(join(data, 'workspace.json'), 'utf8'), ['conversations']);
const check = (label, chats) => {
  assert.equal(chats.length, expected.size, `${label}: conversations`);
  for (const conversation of chats)
    same(settled(conversation), expected.get(conversation.id), `${label}: ${conversation.id}`);
};
try {
  log('workspace loaded');
  // The first save of the start: what the start changed, completed from the file the app read.
  const deadline = Date.now() + 120_000;
  let chats = [];
  for (;;) {
    await sleep(2000);
    assert.equal(await banner(), null);
    chats = saved();
    if (chats.every((c) => c.archived)) break;
    assert(Date.now() < deadline, 'The start was not saved.');
  }
  check('after the start', chats);
  report.start = {
    conversations: chats.length,
    movedToHistory: active,
    workspaceBytes: statSync(join(data, 'workspace.json')).size,
    heapBytes: await heap(),
  };
  log(
    `start saved: every chat in History, the rest unchanged; page heap ${mb(report.start.heapBytes)}`,
  );
  assert(report.start.heapBytes < 2 ** 31, 'The page holds more than 2 GB.');
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.conversation-row').length > 0),
    true,
  );

  // A reload of the window reads it all again and changes nothing.
  for (let round = 1; round <= 2; round++) {
    await page.evaluate(() => (window.storageQaPending = true));
    await page.cdp('Page.reload');
    page.close();
    await sleep(1000);
    page = await connect();
    await sleep(5000);
    assert.equal(await banner(), null);
    check(`after reload ${round}`, saved());
  }
  report.reloadHeapBytes = await heap();
  log(`two reloads read it again; page heap ${mb(report.reloadHeapBytes)}`);
  assert(report.reloadHeapBytes < 2 ** 31, 'The reloaded page holds more than 2 GB.');

  // Every conversation sent back ahead of a save, as a save of everything sends them: each read
  // and each call a few megabytes, whatever the file's size.
  const roundTrip = (kind) =>
    page.evaluate(async (kind) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const encoder = new TextEncoder();
      const names =
        kind === 'workspace'
          ? [
              'open_workspace',
              'read_workspace_chats',
              'stage_workspace_chats',
              'save_workspace_patch',
            ]
          : [
              'open_sync_state',
              'read_sync_state_chats',
              'stage_sync_state_chats',
              'save_sync_state',
            ];
      for (let attempt = 0; ; attempt++) {
        try {
          const opened = await invoke(names[0]);
          if (!opened?.parts) return { whole: true };
          const { rest, chats, read } = opened.parts;
          const save = crypto.randomUUID();
          const stats = { chats: chats.length, calls: 0, bytes: 0, largest: 0 };
          let ids = [];
          let size = 0;
          const flush = async () => {
            if (!ids.length) return;
            const list = new Uint8Array(await invoke(names[1], { read, ids }));
            const head = encoder.encode(`{"save":${JSON.stringify(save)},"upsert":`);
            const body = new Uint8Array(head.length + list.length + 1);
            body.set(head);
            body.set(list, head.length);
            body[body.length - 1] = 125;
            await invoke(names[2], body);
            stats.calls++;
            stats.bytes += list.length;
            stats.largest = Math.max(stats.largest, list.length);
            ids = [];
            size = 0;
          };
          for (const [id, bytes] of chats) {
            if (ids.length && size + bytes > 16_000_000) await flush();
            ids.push(id);
            size += bytes;
          }
          await flush();
          const order = chats.map(([id]) => id);
          const last =
            kind === 'workspace'
              ? { index: rest, order, upsert: [], staged: save }
              : { value: rest, order, upsert: [], staged: save };
          await invoke(names[3], encoder.encode(JSON.stringify(last)));
          if (kind !== 'workspace') await invoke('close_sync_state', { read });
          return stats;
        } catch (error) {
          // The page's own save came between two of these calls.
          if (attempt >= 4 || !/changed while it was read|is needed to save/.test(String(error)))
            return { error: String(error) };
        }
      }
    }, kind);
  report.workspace = await roundTrip('workspace');
  assert.equal(report.workspace.error, undefined, report.workspace.error);
  assert.equal(report.workspace.whole, undefined, 'The app handed the workspace over whole.');
  assert.equal(report.workspace.chats, expected.size);
  check('after a save of everything', saved());
  log(
    `workspace sent back in ${report.workspace.calls} calls of at most ${mb(report.workspace.largest)}, ${mb(report.workspace.bytes)} in all: every conversation unchanged`,
  );
  report.checkpoint = await roundTrip('checkpoint');
  assert.equal(report.checkpoint.error, undefined, report.checkpoint.error);
  assert.equal(report.checkpoint.whole, undefined, 'The app handed the checkpoint over whole.');
  const base = chatsOf(source.checkpoint.toString('utf8'), ['base', 'conversations']);
  const held = chatsOf(readFileSync(join(data, 'sync-state.json'), 'utf8'), [
    'base',
    'conversations',
  ]);
  assert.equal(report.checkpoint.chats, base.length);
  assert.equal(held.length, base.length);
  for (let index = 0; index < base.length; index++)
    same(JSON.stringify(held[index]), JSON.stringify(base[index]), `checkpoint ${base[index].id}`);
  log(
    `checkpoint sent back in ${report.checkpoint.calls} calls of at most ${mb(report.checkpoint.largest)}, ${mb(report.checkpoint.bytes)} in all: every conversation unchanged`,
  );
  assert.equal(await banner(), null);
  // No page of this run ran out of memory.
  const diagnostics = join(data, 'diagnostics');
  report.reports = existsSync(diagnostics)
    ? readdirSync(diagnostics).filter((name) => statSync(join(diagnostics, name)).mtimeMs > started)
    : [];
  assert.deepEqual(report.reports, []);
  console.log(JSON.stringify(report, null, 2));
  log('PASSED');
} finally {
  await close(page).catch((error) => log(`close failed: ${error.message}`));
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
