// Opt-in: a real Codex reply (SHOWN_FILES_QA_PROVIDER, Codex by default) in an isolated native app
// sends a table, a workbook, a document and a video with send_files, and the app's own window
// shows each: the table's pages parsed where it is kept, every sheet of the workbook, the
// document whole, and the video streamed through the studio-file protocol, seeking past its first
// part. Build with scripts/native-shown-files.tauri.json (after `npm run build`), then run this
// with the built executable (SHOWN_FILES_QA_EXECUTABLE). No credentials are copied.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.shown-files-qa';
const port = Number(process.env.SHOWN_FILES_QA_PORT ?? 19881);
const executable = resolve(
  process.env.SHOWN_FILES_QA_EXECUTABLE ?? 'artifacts/shown-files-qa-target/debug/agent-studio.exe',
);
const provider = process.env.SHOWN_FILES_QA_PROVIDER ?? 'codex';
const output = resolve('artifacts/shown-files-qa');
// The files live outside app data, which a packaged parent's shell may see redirected.
const folder = join(output, 'project');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(folder, { recursive: true });

// A table as a spreadsheet saves it where the comma marks decimals: separated by semicolons.
const rows = ['Region;Quarter;Sales;Growth'];
for (let i = 1; i <= 5000; i++)
  rows.push(
    `${['North', 'South', 'East', 'West'][i % 4]};Q${(i % 4) + 1};${(i * 137.5).toFixed(2).replace('.', ',')};${(i % 17) - 8}%`,
  );
const csv = join(folder, 'sales.csv');
await writeFile(csv, rows.join('\r\n') + '\r\n');

const markdown = join(folder, 'report.md');
await writeFile(
  markdown,
  [
    '# Quarterly report',
    '',
    'Sales grew **12%**, led by the *North* region.',
    '',
    '| Region | Sales |',
    '| --- | ---: |',
    '| North | 1,234 |',
    '',
    '```ts',
    'const total = regions.reduce((sum, r) => sum + r.sales, 0);',
    '```',
    '',
    ...Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the details.\n`),
  ].join('\n'),
);

// A workbook of two sheets, zipped by Windows itself.
const parts = join(output, 'workbook-parts');
await rm(parts, { recursive: true, force: true });
const ns =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const workbookParts = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationship}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns}><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationship}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationship}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Region</t></is></c><c r="C2" t="inlineStr"><is><t>Total</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>North</t></is></c><c r="C3"><v>1234.5</v></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>South</t></is></c><c r="C4"><v>0.30000000000000004</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Checked by hand</t></is></c></row></sheetData></worksheet>`,
};
for (const [name, content] of Object.entries(workbookParts)) {
  await mkdir(join(parts, name, '..'), { recursive: true });
  await writeFile(join(parts, name), content);
}
const workbook = join(folder, 'q3.xlsx');
await rm(workbook, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${parts}', '${workbook}')`,
]);

// A video of several megabytes, so playing and seeking ask for more than the first part.
const browser = await chromium.launch({ channel: 'msedge' });
const recorded = await (
  await browser.newPage()
).evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  const type = ['video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  const recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType: type,
    videoBitsPerSecond: 16_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start(250);
  for (let frame = 0; frame < 150; frame++) {
    // Noise keeps the encoder busy, so the file is large.
    const image = context.createImageData(1280, 720);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = (i * frame) % 255;
      image.data[i + 1] = Math.random() * 255;
      image.data[i + 2] = frame * 1.7;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    context.fillStyle = 'white';
    context.font = '160px sans-serif';
    context.fillText(String(frame), 520, 420);
    await new Promise((resolve) => setTimeout(resolve, 33));
  }
  recorder.stop();
  await new Promise((resolve) => (recorder.onstop = resolve));
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: blob.type, data: btoa(binary) };
});
await browser.close();
const video = join(folder, recorded.type === 'video/mp4' ? 'clip.mp4' : 'clip.webm');
await writeFile(video, Buffer.from(recorded.data, 'base64'));
console.log(`video: ${recorded.type}, ${(recorded.data.length * 0.75) / 1024 ** 2} MB`);

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
async function until(check, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, `${what} timed out`);
    await sleep(250);
  }
}

launch();
const page = await open();
await page.quitOnClose();
const report = { checkedAt: new Date().toISOString(), provider, video: recorded.type };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
};
try {
  const identity = await page.invoke('get_installation');
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Shown files QA')),
    'Use only a disposable Shown Files QA workspace.',
  );
  let account = workspace.fleet.accounts.find(
    (a) =>
      a.provider === provider &&
      workspace.fleet.connections.some(
        (c) => c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
      ),
  );
  if (!account) {
    account = { id: crypto.randomUUID(), provider, name: `Shown files QA ${provider}` };
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
  const now = new Date().toISOString();
  const chat = {
    id: crypto.randomUUID(),
    title: `Shown files QA ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider,
      model: provider === 'claude' ? 'sonnet' : '',
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  };
  workspace.conversations.push(chat);
  // The app's own first save can land after this one, so seed until the chat is listed.
  await until(
    async () => {
      const current = await page.invoke('load_workspace');
      if (!current.conversations.some((c) => c.id === chat.id)) {
        current.fleet = workspace.fleet;
        current.conversations.push(chat);
        await page.invoke('save_workspace', { workspace: current });
        await page.cdp('Page.reload');
        await sleep(1500);
      }
      return page.evaluate(
        (title) =>
          [...document.querySelectorAll('.conversation-item')].some((e) =>
            e.textContent.includes(title),
          ) || (document.querySelector('#conversation-tab-history')?.click(), false),
        chat.title,
      );
    },
    60_000,
    'Seeding the chat',
  );
  assert.equal(
    (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
    'ready',
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  const files = [csv, workbook, markdown, video];
  await page.evaluate(
    (text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    `This is a disposable test folder. Call the send_files tool exactly once, with id "qa", files ${JSON.stringify(files)} and caption "QA files". Do not open, convert or change the files, and run nothing else. Then reply with one short sentence followed by the line <!-- files:qa --> on its own.`,
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const reply = await until(
    async () => {
      const saved = await page.invoke('load_workspace');
      const message = saved.conversations
        .find((c) => c.id === chat.id)
        ?.messages.find((m) => m.role === 'assistant' && m.status !== 'running');
      return message && (message.status === 'complete' ? message : { failed: message });
    },
    240_000,
    'The reply',
  );
  assert(!reply.failed, `The reply failed: ${reply.failed?.error}`);
  const group = reply.extraSentFiles?.find((g) => g.id === 'qa');
  assert(group, 'The reply keeps its group with the files earlier releases cannot show');
  assert.equal(reply.sentFiles?.length ?? 0, 0);
  report.files = group.files.map((f) => ({ name: f.name, type: f.mediaType, bytes: f.bytes }));
  assert.deepEqual(
    group.files.map((f) => f.mediaType),
    [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/markdown',
      recorded.type,
    ],
  );
  const source = { runId: group.runId, toolId: group.toolId };
  // The host parses the table where it keeps it, a page at a time, with its own separator.
  const last = await page.invoke('read_tool_output_table', {
    ...source,
    index: 0,
    sheet: 0,
    start: 4995,
    count: 50,
  });
  assert.equal(last.sheets[0].rows, 5001);
  assert.equal(last.sheets[0].columns, 4);
  assert.equal(last.rows.length, 6);
  assert.equal(last.rows.at(-1)[2], '687500,00');
  // Each column sized by its longest cell, the last rows' longer numbers included.
  assert.deepEqual(last.lengths, [6, 7, 9, 6]);
  const notes = await page.invoke('read_tool_output_table', {
    ...source,
    index: 1,
    sheet: 1,
    start: 0,
    count: 10,
  });
  assert.deepEqual(notes.rows, [['Checked by hand']]);
  const summary = await page.invoke('read_tool_output_table', {
    ...source,
    index: 1,
    sheet: 0,
    start: 0,
    count: 10,
  });
  assert.deepEqual(summary.rows[2], ['South', '0.3']);
  assert.equal(summary.sheets[0].firstRow, 2);
  const head = await page.invoke('read_tool_output_document', { ...source, index: 2, head: 512 });
  assert.equal(head.complete, false);
  const whole = await page.invoke('read_tool_output_document', { ...source, index: 2 });
  assert(whole.complete && whole.text.includes('Paragraph 80'));
  report.table = { rows: last.sheets[0].rows, columns: last.sheets[0].columns };

  // The window: cards in the reply, then each file whole in the viewer.
  await page.waitFor(() => document.querySelector('.message video')?.readyState >= 1);
  const played = await page.evaluate(async () => {
    const video = document.querySelector('.message video');
    const src = video.currentSrc;
    const duration = video.duration;
    video.muted = true;
    // Past the first 2 MiB part, which the stream answers on its own request.
    await new Promise((resolve) => {
      video.addEventListener('seeked', resolve, { once: true });
      video.currentTime = Number.isFinite(duration) ? duration * 0.8 : 3;
    });
    await video.play();
    const from = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 600));
    video.pause();
    return {
      src,
      duration,
      from,
      to: video.currentTime,
      width: video.videoWidth,
      buffered: [...Array(video.buffered.length)].map((_, i) => [
        video.buffered.start(i),
        video.buffered.end(i),
      ]),
    };
  });
  report.video = played;
  assert(played.src.startsWith('http://studio-file.localhost/'), played.src);
  assert(played.to > played.from, 'The video plays from where it was sought');
  assert.equal(played.width, 1280);
  await page.evaluate(() =>
    document.querySelector('.message .file-card')?.scrollIntoView({ block: 'start' }),
  );
  await sleep(500);
  await capture('reply');
  await page.button('Expand sales.csv');
  await page.waitFor(
    () => !!document.querySelector('dialog[aria-label="Table preview"] .table-grid'),
  );
  await page.evaluate(() => {
    document.querySelector('dialog .table-grid').scrollTo({ top: 120_000, behavior: 'instant' });
  });
  await page.waitFor(() =>
    [...document.querySelectorAll('dialog .table-grid [role="rowheader"]')].some(
      (cell) => Number(cell.textContent) > 4000,
    ),
  );
  await sleep(300);
  await capture('table');
  await page.button('Next file');
  await page.waitFor(() => !!document.querySelector('dialog [role="tab"]'));
  await page.evaluate(() =>
    [...document.querySelectorAll('dialog [role="tab"]')]
      .find((t) => t.textContent === 'Notes')
      .click(),
  );
  await page.waitFor(() =>
    document.querySelector('dialog')?.textContent.includes('Checked by hand'),
  );
  await capture('workbook');
  await page.button('Next file');
  await page.waitFor(() => document.querySelector('dialog')?.textContent.includes('Paragraph 80'));
  await capture('document');
  await page.button('Next file');
  await page.waitFor(() => document.querySelector('dialog video')?.readyState >= 2);
  await sleep(300);
  await capture('video');
  report.errors = page.errors;
  report.passed = true;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await page.button('Close window').catch(() => {});
  page.close();
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);
