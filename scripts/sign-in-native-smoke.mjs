// Opt-in native proof that Claude Code signs in without a terminal from the desktop app. Add
// account starts the CLI's own sign-in as a hidden process and Connections shows it waiting; a
// code from another sign-in is refused before it reaches the CLI; a well-formed code goes to the
// CLI, which tries it at Anthropic's token endpoint and fails; and a sign-in survives a reload
// and ends on Cancel. No browser opens and no account signs in: the app runs with BROWSER naming
// no program, which Claude Code uses instead of the default browser. The driver starts the QA
// build itself to pass BROWSER along, so run it from a shell outside an MSIX package
// (`--check-startup` refuses first otherwise). Build with scripts/native-sign-in.tauri.json
// (CDP 19821); SIGN_IN_QA_EXECUTABLE names the built exe.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.sign-in-qa';
const executable = resolve(
  process.env.SIGN_IN_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = resolve('artifacts/sign-in-native');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const powershell = (script, env = {}) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
// What runs under the QA app, apart from its WebView, with the window each process shows.
const processes = () =>
  JSON.parse(
    powershell(
      `$all = @(Get-CimInstance Win32_Process)
$apps = @($all | Where-Object { $_.ExecutablePath -eq $env:QA_EXE } | ForEach-Object { [int]$_.ProcessId })
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($id in $apps) { [void]$seen.Add($id) }
do {
  $added = $false
  foreach ($p in $all) { if ($seen.Contains([int]$p.ParentProcessId) -and $seen.Add([int]$p.ProcessId)) { $added = $true } }
} while ($added)
$found = @($all | Where-Object { $seen.Contains([int]$_.ProcessId) -and $apps -notcontains [int]$_.ProcessId -and $_.Name -ne 'msedgewebview2.exe' } | ForEach-Object {
  $window = 0
  try { $window = [int64](Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle } catch {}
  @{ pid = [int]$_.ProcessId; name = [string]$_.Name; command = [string]$_.CommandLine; window = $window }
})
ConvertTo-Json -InputObject $found -Compress -Depth 3`,
      { QA_EXE: executable },
    ) || '[]',
  );
const signingIn = () =>
  processes().filter((p) => p.name === 'claude.exe' && /\bauth login\b/.test(p.command));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Starting it from here keeps BROWSER for the CLI; a redirected app-data folder refuses first.
execFileSync(executable, ['--check-startup'], { stdio: 'inherit', windowsHide: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CLAUDE/.test(key)));
spawn(executable, [], {
  env: { ...env, BROWSER: 'agent-studio-qa-no-browser' },
  detached: true,
  stdio: 'ignore',
}).unref();

async function connect() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(19821);
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
const page = await connect();
const shot = async (name) => {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(data, 'base64'));
};
const openConnections = async () => {
  await page.button('Connections');
  await page.waitFor(() => document.querySelector('h1')?.textContent?.trim() === 'Connections');
};
const inRow = (id, selector) => `[data-connection="${id}"] ${selector}`;
const pressIn = (id, label) =>
  page.evaluate(
    (id, label) => {
      const button = [...document.querySelectorAll(`[data-connection="${id}"] button`)].find(
        (b) => b.innerText.trim() === label,
      );
      if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
      button.click();
    },
    id,
    label,
  );
const waitForText = (selector, text, timeout = 30_000) =>
  page.evaluate(
    async (selector, text, timeout) => {
      const deadline = Date.now() + timeout;
      while (!document.querySelector(selector)?.textContent?.includes(text)) {
        if (Date.now() > deadline)
          throw new Error(
            `${selector} reads "${document.querySelector(selector)?.textContent ?? ''}", not "${text}"`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    selector,
    text,
    timeout,
  );
const pasteCode = async (id, code) => {
  await page.evaluate(
    (selector, code) => {
      const input = document.querySelector(selector);
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    inRow(id, 'input[data-sign-in-code]'),
    code,
  );
  await page.waitFor(
    (selector) => document.querySelector(selector)?.disabled === false,
    inRow(id, '.sign-in-code button[type="submit"]'),
  );
  await page.click(inRow(id, '.sign-in-code button[type="submit"]'));
};

let failure;
try {
  await page.quitOnClose();
  // This QA identity never updates the computer's CLIs by itself.
  for (const provider of ['claude', 'codex'])
    await page.invoke('set_cli_auto_update', { provider, automatic: false }).catch(() => {});
  await openConnections();

  // Add account opens the account's sign-in: a hidden CLI, and no terminal. It waits for the
  // computer's CLI inventory.
  await page.waitFor(
    () =>
      [...document.querySelectorAll('.computer-heading button')].find(
        (b) => b.innerText.trim() === 'Add account',
      )?.disabled === false,
  );
  await page.evaluate(() => {
    const add = [...document.querySelectorAll('.computer-heading button')].find(
      (b) => b.innerText.trim() === 'Add account',
    );
    if (!add || add.disabled) throw new Error('Add account is unavailable');
    add.click();
  });
  await page.waitFor(
    () => !!document.querySelector('dialog[open] input[aria-label="Account name"]'),
  );
  await waitForText('dialog[open] [aria-label="Account provider"]', 'Claude');
  await page.evaluate(() => {
    const input = document.querySelector('dialog[open] input[aria-label="Account name"]');
    input.value = 'Sign-in QA';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() =>
    [...document.querySelectorAll('dialog[open] button')]
      .find((b) => b.innerText.trim() === 'Add account')
      .click(),
  );
  await page.waitFor(() => !document.querySelector('dialog[open]'));
  const id = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.fleet-account')].find(
      (c) => c.querySelector('h4')?.textContent?.trim() === 'Sign-in QA',
    );
    return card?.querySelector('[data-connection]')?.getAttribute('data-connection');
  });
  assert(id, 'The new account has no row');
  await waitForText(inRow(id, '.sign-in-progress [role="status"]'), 'Finish signing in to Claude');
  const cli = signingIn();
  assert.equal(cli.length, 1, `one hidden sign-in runs: ${JSON.stringify(processes())}`);
  assert.equal(cli[0].window, 0, 'the CLI shows no window');
  assert(
    !processes().some((p) => /powershell|pwsh|WindowsTerminal|cmd\.exe/i.test(p.name)),
    `no terminal opened: ${JSON.stringify(processes())}`,
  );
  const [view] = (await page.invoke('sign_ins')).filter((v) => v.connectionId === id);
  assert(view?.code && view.url?.startsWith('https://'), JSON.stringify(view));
  const state = new URL(view.url).searchParams.get('state');
  assert(state, 'the page carries its state');
  await page.evaluate(
    (selector) => document.querySelector(selector).scrollIntoView({ block: 'center' }),
    `[data-connection="${id}"]`,
  );
  await shot('waiting');

  // The code field opens focused; a code from another sign-in never reaches the CLI.
  await pressIn(id, 'Page shows a code?');
  await page.waitFor(
    (selector) => document.activeElement === document.querySelector(selector),
    inRow(id, 'input[data-sign-in-code]'),
  );
  await pasteCode(id, 'qa-not-a-code#another-sign-in');
  await waitForText(inRow(id, '.sign-in-progress [role="alert"]'), 'another sign-in');
  assert.equal(signingIn().length, 1);
  await shot('another-code');

  // A well-formed code goes to the CLI, which tries it at Anthropic and fails.
  await pasteCode(id, `qa-not-a-real-code#${state}`);
  await waitForText(inRow(id, '.sign-in-ended'), 'Claude did not accept the code', 60_000);
  const refused = await page.evaluate(
    (selector) => document.querySelector(selector).textContent.trim(),
    inRow(id, '.sign-in-ended'),
  );
  console.log(`Refused code: ${refused}`);
  await sleep(500);
  assert.equal(signingIn().length, 0, 'the CLI ended');
  await shot('refused');

  // Signing in again survives a reload of the window, and Cancel ends the CLI.
  await pressIn(id, 'Open sign-in');
  await waitForText(inRow(id, '.sign-in-progress [role="status"]'), 'Finish signing in to Claude');
  assert.equal(signingIn().length, 1);
  await page.cdp('Page.reload');
  await sleep(1000);
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await openConnections();
  await waitForText(inRow(id, '.sign-in-progress [role="status"]'), 'Finish signing in to Claude');
  await pressIn(id, 'Cancel');
  await page.waitFor(
    (selector) => !document.querySelector(selector),
    inRow(id, '.sign-in-progress'),
  );
  for (let i = 0; signingIn().length && i < 20; i++) await sleep(250);
  assert.equal(signingIn().length, 0, 'Cancel ended the CLI');
  assert.equal((await page.invoke('sign_ins')).length, 0);
  await shot('cancelled');
  assert.deepEqual(page.errors, [], 'no page errors');
  console.log('Native sign-in smoke passed.');
} catch (error) {
  failure = error;
  await shot('failure').catch(() => {});
} finally {
  await page.button('Close window').catch(() => {});
  page.close();
  for (let i = 0; i < 40; i++) {
    const running = powershell(
      `@(Get-CimInstance Win32_Process -Filter "Name='agent-studio.exe'" | Where-Object { $_.ExecutablePath -eq $env:QA_EXE }).Count`,
      { QA_EXE: executable },
    ).trim();
    if (running === '0') break;
    await sleep(250);
  }
  // The QA identity's data holds only this run's account and its profile.
  await rm(join(process.env.LOCALAPPDATA, identifier), { recursive: true, force: true }).catch(
    (error) => console.warn(`Could not remove the QA data: ${error.message}`),
  );
}
if (failure) throw failure;
process.exit(0);
