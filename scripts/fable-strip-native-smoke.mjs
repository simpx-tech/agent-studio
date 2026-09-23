// Isolated native check: a live Claude Fable reading joins the composer usage strip.
// Build with scripts/native-fable-strip.tauri.json. Read-only: it sends no message and only
// reads usage through the detected Claude CLI login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.fable-strip-qa';
const port = Number(process.env.FABLE_STRIP_QA_PORT ?? 19686);
const executable = resolve(
  process.env.FABLE_STRIP_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/fable-strip';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

// Task Scheduler launch: normal Windows storage, never an inherited packaged-app context.
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
let page;
for (const deadline = Date.now() + 60_000; ;) {
  try {
    page = await nativePage(port);
    assert.equal(await page.invoke('plugin:app|identifier'), identifier);
    break;
  } catch (error) {
    if (Date.now() > deadline) throw error;
    await sleep(500);
  }
}
// Model catalogs and usage wait for sign-in checks and a CLI read of up to 25 seconds.
async function until(condition, ...args) {
  const deadline = Date.now() + 90_000;
  while (!(await page.evaluate(condition, ...args))) {
    assert(Date.now() < deadline, `UI condition timed out: ${condition}`);
    await sleep(250);
  }
}
async function choose(label, prefix) {
  const trigger = `[role="combobox"][aria-label="${label}"]`;
  await until((trigger) => document.querySelector(trigger)?.disabled === false, trigger);
  for (const deadline = Date.now() + 90_000; ;) {
    await page.click(trigger);
    await until(() => !!document.querySelector('[role="option"], .picker-empty'));
    const chosen = await page.evaluate((prefix) => {
      const option = [...document.querySelectorAll('[role="option"]')].find((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith(prefix),
      );
      option?.click();
      return !!option;
    }, prefix);
    if (chosen) return;
    await page.click(trigger);
    assert(Date.now() < deadline, `${label} option not available: ${prefix}`);
    await sleep(1000);
  }
}
const strip = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.usage-strip .usage-chip')].map((chip) => {
      const meter = chip.querySelector('[role="progressbar"]');
      const text = chip.querySelector('.usage-bar-value strong')?.getBoundingClientRect();
      const arrow = chip.querySelector('.usage-bar-value .pace-indicator');
      const box = arrow?.getBoundingClientRect();
      const middle = box && box.top + box.height / 2;
      return {
        label: chip.querySelector('.usage-bar-heading > span')?.textContent.trim(),
        value: chip.querySelector('.usage-bar-heading strong')?.textContent.trim(),
        meter: meter?.getAttribute('aria-label'),
        valueNow: meter?.getAttribute('aria-valuenow') ?? null,
        pace: arrow?.getAttribute('aria-label') ?? null,
        arrowBesideValue: !box || (middle > text.top && middle < text.bottom),
      };
    }),
  );
const overflows = () =>
  page.evaluate(() => {
    const strip = document.querySelector('.usage-strip');
    return (
      strip.scrollWidth > strip.clientWidth ||
      document.documentElement.scrollWidth > window.innerWidth
    );
  });
function qaRunning() {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'agent-studio.exe\'" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress',
    ],
    { windowsHide: true },
  )
    .toString()
    .trim();
  return [raw ? JSON.parse(raw) : []]
    .flat()
    .some((path) => path?.toLowerCase() === executable.toLowerCase());
}

const report = { checkedAt: new Date().toISOString(), widths: {} };
try {
  await until(() => document.querySelector('[aria-label="New conversation"]')?.disabled === false);
  const workspace = await page.invoke('load_workspace');
  assert.equal(workspace.conversations.length, 0, 'Use only an empty Fable Strip QA workspace.');
  await choose('Agent', 'Claude');
  await choose('Model', 'Fable');
  report.model = await page.evaluate(() =>
    document.querySelector('[role="combobox"][aria-label="Model"]')?.textContent.trim(),
  );
  await until(() =>
    document
      .querySelector('.usage-strip [role="progressbar"][aria-label="Fable weekly limit used"]')
      ?.hasAttribute('aria-valuenow'),
  );
  for (const [width, height] of [
    [1380, 900],
    [880, 720],
    [390, 844],
  ]) {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);
    const chips = await strip();
    report.widths[width] = chips;
    assert.deepEqual(
      chips.map((chip) => chip.meter),
      ['Context used', '5-hour limit used', 'Weekly limit used', 'Fable weekly limit used'],
    );
    assert.equal(chips[3].label, 'Fable weekly');
    assert.match(chips[3].value, /^\d+(\.\d)?% used$/);
    assert(
      chips.every((chip) => chip.arrowBesideValue),
      `Arrow wrapped alone at ${width}px`,
    );
    assert.equal(await overflows(), false, `Usage strip overflows at ${width}px`);
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `native-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  await choose('Model', 'Sonnet');
  await until(() => document.querySelectorAll('.usage-strip [role="progressbar"]').length === 3);
  report.sonnet = await strip();
  assert(!report.sonnet.some((chip) => chip.meter === 'Fable weekly limit used'));
  assert.deepEqual(page.errors, []);
  report.passed = true;
} finally {
  await writeFile(join(output, 'native-result.json'), JSON.stringify(report, null, 2));
  await page.button('Close window').catch(() => {});
  page.close();
  const deadline = Date.now() + 30_000;
  while (qaRunning()) {
    assert(Date.now() < deadline, 'The Fable Strip QA app did not close.');
    await sleep(250);
  }
}
