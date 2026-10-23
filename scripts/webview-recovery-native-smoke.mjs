// Opt-in real Codex reply in an isolated native app: the window comes back by itself when WebView2's
// own processes end under it (src-tauri/src/window_recovery.rs). Ending the app's WebView2 browser
// process while a reply runs a shell command, as Windows' memory running out did on 2026-10-23,
// closes the webview for good: the app builds the window again, maximized as it was, the new page
// follows the reply to its end, and the chat stays in Active. Ending the page's renderer instead
// shows WebView2's error page, which the app replaces by loading the page again. Each failure is
// kept as a `webviewProcess` report with its repair and when it was done. Last, the browser
// process is suspended, which leaves every WebView2 process alive with nothing passing between
// the page and the app, as at 13:08 that day: a minute on, the app ends it and builds the window
// again, the new page takes the end of a reply that ended meanwhile, and the `windowSilent`
// report keeps the repair.
//
//   npm run build
//   npx tauri build --debug --no-bundle --config scripts/native-webview-recovery.tauri.json
//   RECOVERY_QA_EXECUTABLE=<long path of that agent-studio.exe> node scripts/webview-recovery-native-smoke.mjs
//
// No credentials are copied: the QA identity uses this computer's own Codex login, and the chat
// works in a disposable folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.recovery-qa';
const port = 19891;
const executable = resolve(
  process.env.RECOVERY_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const diagnostics = join(process.env.LOCALAPPDATA, identifier, 'diagnostics');
const output = 'artifacts/webview-recovery-native';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

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
// The app and its WebView2 processes, from Windows' own list.
function processes() {
  const listed = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='agent-studio.exe' or Name='msedgewebview2.exe'\" | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  return [listed ? JSON.parse(listed) : []].flat();
}
const webviewChildren = (all, parent) =>
  all.filter(
    (p) => p.ParentProcessId === parent && /msedgewebview2\.exe$/i.test(p.ExecutablePath ?? ''),
  );
// The QA app and its WebView2 browser process, while it has one.
function browserOf(all = processes()) {
  const app = all.find((p) => p.ExecutablePath?.toLowerCase() === executable.toLowerCase());
  const browser =
    app && webviewChildren(all, app.ProcessId).find((p) => !/--type=/.test(p.CommandLine ?? ''));
  return { app, browser, all };
}
function browserProcess() {
  const { app, browser, all } = browserOf();
  assert(app, 'The QA app is not running');
  assert(browser, 'The QA app has no WebView2 browser process');
  return {
    app,
    browser,
    renderers: webviewChildren(all, browser.ProcessId).filter((p) =>
      /--type=renderer/.test(p.CommandLine),
    ),
  };
}
const end = (pid) =>
  execFileSync('taskkill.exe', ['/F', '/PID', String(pid)], { windowsHide: true });
// Stops every thread of a process where it is, without ending it.
function suspend(pid) {
  const script = `Add-Type -Namespace Qa -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int id); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);'
$process = [Qa.Nt]::OpenProcess(0x0800, $false, ${Number(pid)})
if ($process -eq [IntPtr]::Zero) { throw 'Cannot open the process' }
$status = [Qa.Nt]::NtSuspendProcess($process)
[void][Qa.Nt]::CloseHandle($process)
if ($status -ne 0) { throw "NtSuspendProcess failed: $status" }`;
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
}

const ready = () => document.querySelector('[aria-label="New conversation"]')?.disabled === false;
// Connects to the app's page, once it answers and shows the chat.
async function connect(condition = ready, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let page;
    try {
      page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(condition);
      return page;
    } catch (error) {
      page?.close();
      if (Date.now() > deadline) throw error;
      await sleep(250);
    }
  }
}
async function reports(kind, repair) {
  const found = [];
  for (const report of await written('webviewProcess'))
    if (report.process?.kind === kind && report.repair === repair) found.push(report);
  return found;
}
async function written(kind) {
  const found = [];
  for (const name of await readdir(diagnostics).catch(() => [])) {
    if (!name.endsWith(`-${kind}.json`)) continue;
    found.push({ name, ...JSON.parse(await readFile(join(diagnostics, name), 'utf8')) });
  }
  return found;
}
async function repaired(kind, repair, since) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const report = (await reports(kind, repair)).find(
      (r) => Date.parse(r.detectedAt) >= since && r.recoveredAfterMs != null,
    );
    if (report) return report;
    assert(Date.now() < deadline, `No repaired ${kind} report`);
    await sleep(500);
  }
}

launch();
let page = await connect();
await page.quitOnClose();
const report = { checkedAt: new Date().toISOString() };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
const windowCall = (command) => page.invoke(`plugin:window|${command}`, { label: 'main' });
const chat = { id: crypto.randomUUID(), title: `Recovery QA command ${Date.now()}` };
try {
  const identity = await page.invoke('get_installation');
  // A first launch saves its workspace once startup detection finishes.
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Recovery QA')),
    'Use only a disposable Recovery QA workspace.',
  );
  let connection = workspace.fleet.connections.find(
    (c) =>
      c.environmentId === identity.id &&
      c.profile === 'existing' &&
      workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === 'codex',
  );
  if (!connection) {
    const account = { id: crypto.randomUUID(), provider: 'codex', name: 'Recovery QA codex' };
    connection = {
      id: crypto.randomUUID(),
      accountId: account.id,
      environmentId: identity.id,
      profile: 'existing',
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(connection);
  }
  const catalog = await page.invoke('list_models', {
    provider: 'codex',
    connectionId: connection.id,
  });
  const model = (catalog.codex ?? []).find((m) => m.id)?.id ?? '';
  report.model = model;
  const now = new Date().toISOString();
  workspace.conversations.push({
    id: chat.id,
    title: chat.title,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider: 'codex',
      model,
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: {
      computerId: identity.computerId,
      environmentId: identity.id,
      path: await mkdtemp(join(tmpdir(), 'studio-recovery-')),
    },
    messages: [],
  });
  const rows = () =>
    page.evaluate(async () => {
      const titles = [];
      for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
        document.querySelector(tab)?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (const row of document.querySelectorAll('.conversation-item'))
          // A row's title adds notes, such as New reply, after the chat's name.
          titles.push({ title: row.title.split(' · ')[0], tab });
      }
      return titles;
    });
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded page lists the chat.
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    for (const key of ['accounts', 'connections'])
      for (const item of workspace.fleet[key])
        if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
    for (const conversation of workspace.conversations)
      if (!current.conversations.some((c) => c.id === conversation.id))
        current.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.recoveryQaSeeded = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.recoveryQaSeeded &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    await sleep(2000);
    if ((await rows()).some((r) => r.title === chat.title)) break;
    assert(attempt < 5, 'The seeded chat did not survive the reload');
  }
  const status = await page.invoke('detect_connection', {
    provider: 'codex',
    connectionId: connection.id,
  });
  assert.equal(status.auth, 'ready', 'Codex must be signed in on this computer');

  const openChat = async () => {
    await page.evaluate(async (title) => {
      for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
        document.querySelector(tab)?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const row = [...document.querySelectorAll('.conversation-item')].find(
          (e) => e.title.split(' · ')[0] === title,
        );
        if (row) return row.click();
      }
    }, chat.title);
    await page.waitFor(
      (title) =>
        document.querySelector('.conversation-item[aria-current="page"]')?.title.split(' · ')[0] ===
        title,
      chat.title,
    );
  };
  const reply = async () =>
    (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.findLast((m) => m.role === 'assistant');
  const answer = (message) =>
    message.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('\n');
  const noBanner = async () =>
    assert.equal(
      await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null),
      null,
    );

  // The window's normal place, then maximized as the user's was.
  report.normal = {
    position: await windowCall('outer_position'),
    size: await windowCall('inner_size'),
  };
  await windowCall('toggle_maximize');
  await page.waitFor(
    async () =>
      await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', { label: 'main' }),
  );

  await openChat();
  await page.evaluate((text) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'This is a disposable test folder. Run exactly one shell command in the foreground and allow it up to 120 seconds: `Start-Sleep -Seconds 30`. When it has finished, reply exactly: RECOVERY COMMAND DONE');
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const started = Date.now();
  while (
    !(await page.evaluate(() =>
      [...document.querySelectorAll('.message:not(.user)')]
        .at(-1)
        ?.textContent.includes('Start-Sleep'),
    ))
  ) {
    assert(Date.now() - started < 180_000, 'the command did not start');
    await sleep(250);
  }
  const running = await reply();
  assert.equal(running.status, 'running', running.error);
  chat.runId = running.runId;
  assert((await page.invoke('live_runs')).some((run) => run.runId === chat.runId));
  await capture('before-browser-ends');

  // WebView2's browser process ends, as it did when Windows refused it memory.
  const before = browserProcess();
  report.browserBefore = before.browser.ProcessId;
  page.close();
  const browserEnded = Date.now();
  end(before.browser.ProcessId);
  page = await connect();
  report.windowBackAfterMs = Date.now() - browserEnded;
  await sleep(2000);
  await noBanner();
  const after = browserProcess();
  report.browserAfter = after.browser.ProcessId;
  assert.notEqual(after.browser.ProcessId, before.browser.ProcessId);
  assert.equal(after.app.ProcessId, before.app.ProcessId, 'the app itself ran on');
  assert.equal(await windowCall('is_maximized'), true, 'the window came back maximized');
  assert.equal(await windowCall('is_visible'), true);
  const followed = await reply();
  report.replyAfterRebuild = { status: followed.status, error: followed.error ?? null };
  assert.equal(followed.status, 'running', followed.error);
  assert(
    (await rows()).some((r) => r.title === chat.title && r.tab === '#conversation-tab-active'),
    'the chat stayed in Active',
  );
  await openChat();
  await page.waitFor(() =>
    [...document.querySelectorAll('button')].some(
      (b) => (b.getAttribute('aria-label') ?? b.innerText).trim() === 'Stop response',
    ),
  );
  await capture('after-window-rebuilt');
  const deadline = Date.now() + 240_000;
  let done;
  for (;;) {
    done = await reply();
    if (done.status !== 'running') break;
    assert(Date.now() < deadline, 'the followed reply did not end');
    await sleep(500);
  }
  report.reply = {
    status: done.status,
    error: done.error ?? null,
    answer: answer(done),
    calls: done.blocks.filter((b) => b.tool).map((b) => [b.tool.command, b.tool.status]),
  };
  assert.equal(done.status, 'complete', done.error);
  assert.match(answer(done), /RECOVERY COMMAND DONE/);
  assert(done.blocks.some((b) => b.tool?.command && b.tool.status === 'complete'));
  await capture('reply-done');
  const browserReport = await repaired('browserProcessExited', 'window', browserEnded - 1000);
  report.browserReport = browserReport;

  // Restored from maximized, the window takes the place it had before.
  await windowCall('toggle_maximize');
  await page.waitFor(
    async () =>
      !(await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', { label: 'main' })),
  );
  report.restored = {
    position: await windowCall('outer_position'),
    size: await windowCall('inner_size'),
  };
  assert.deepEqual(report.restored, report.normal);

  // The page's renderer ends: WebView2 shows its error page, and the page loads again.
  await page.evaluate(() => (window.recoveryQaDocument = true));
  const renderers = browserProcess().renderers;
  assert(renderers.length > 0, 'The page has no renderer process');
  page.close();
  const rendererEnded = Date.now();
  for (const renderer of renderers) end(renderer.ProcessId);
  page = await connect(
    () =>
      !window.recoveryQaDocument &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  report.pageBackAfterMs = Date.now() - rendererEnded;
  await sleep(2000);
  await noBanner();
  assert.equal(browserProcess().browser.ProcessId, after.browser.ProcessId, 'the browser ran on');
  report.pageReport = await repaired('renderProcessExited', 'page', rendererEnded - 1000);
  await capture('after-page-reloaded');

  // Every WebView2 process lives on while nothing passes between the page and the app: the
  // browser process is suspended as a reply runs a command. A minute on, the app ends it and
  // builds the window again, and the new page takes the end of the reply, which ended meanwhile.
  await openChat();
  report.silentPageShown = await page.evaluate(() => document.visibilityState);
  assert.equal(report.silentPageShown, 'visible', 'Only a shown page owes the app its calls');
  await page.evaluate((text) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'Run exactly one shell command in the foreground and allow it up to 120 seconds: `Start-Sleep -Seconds 15`. When it has finished, reply exactly: SILENT COMMAND DONE');
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const silentSent = Date.now();
  while (
    !(await page.evaluate(() =>
      [...document.querySelectorAll('.message:not(.user)')]
        .at(-1)
        ?.textContent.includes('Start-Sleep -Seconds 15'),
    ))
  ) {
    assert(Date.now() - silentSent < 180_000, 'the second command did not start');
    await sleep(250);
  }
  const silent = await reply();
  assert.equal(silent.status, 'running', silent.error);
  assert.notEqual(silent.runId, chat.runId);
  chat.runId = silent.runId;
  const quiet = browserProcess();
  page.close();
  const suspendedAt = Date.now();
  suspend(quiet.browser.ProcessId);
  // The suspended browser process holds the debugging port: wait for the one that follows it.
  for (;;) {
    const next = browserOf().browser;
    if (next && next.ProcessId !== quiet.browser.ProcessId) break;
    assert(Date.now() - suspendedAt < 240_000, 'the silent page was not repaired');
    await sleep(1000);
  }
  report.silentBrowserReplacedAfterMs = Date.now() - suspendedAt;
  page = await connect();
  report.silentWindowBackAfterMs = Date.now() - suspendedAt;
  await sleep(2000);
  await noBanner();
  assert.equal(browserProcess().app.ProcessId, before.app.ProcessId, 'the app itself ran on');
  assert.equal(await windowCall('is_visible'), true);
  // The suspended browser process went, and its own processes with it.
  report.silentLeftBehind = processes().filter(
    (p) =>
      p.ProcessId === quiet.browser.ProcessId ||
      webviewChildren([p], quiet.browser.ProcessId).length > 0,
  );
  assert.deepEqual(report.silentLeftBehind, []);
  const silentDeadline = Date.now() + 240_000;
  let silentDone;
  for (;;) {
    silentDone = await reply();
    if (silentDone.runId === silent.runId && silentDone.status !== 'running') break;
    assert(Date.now() < silentDeadline, 'the reply did not end in the new page');
    await sleep(500);
  }
  report.silentReply = {
    status: silentDone.status,
    error: silentDone.error ?? null,
    answer: answer(silentDone),
  };
  assert.equal(silentDone.status, 'complete', silentDone.error);
  assert.match(answer(silentDone), /SILENT COMMAND DONE/);
  await openChat();
  await capture('after-silent-page');
  // The silence is reported with its repair and when the new page called, and what WebView2
  // said of the browser process the app ended asks for no repair of its own.
  const reportDeadline = Date.now() + 60_000;
  for (;;) {
    report.silenceReport = (await written('windowSilent')).find(
      (r) => Date.parse(r.detectedAt) >= suspendedAt && r.recoveredAfterMs != null,
    );
    if (report.silenceReport) break;
    assert(Date.now() < reportDeadline, 'No windowSilent report heard again');
    await sleep(500);
  }
  assert.equal(report.silenceReport.repair, 'window');
  assert.equal(report.silenceReport.error, undefined);
  report.endedBrowserReports = (await written('webviewProcess')).filter(
    (r) => Date.parse(r.detectedAt) >= suspendedAt,
  );
  assert(report.endedBrowserReports.every((r) => r.repair === undefined));

  report.liveAtEnd = await page.invoke('live_runs');
  assert.deepEqual(report.liveAtEnd, []);
  report.rendererErrors = page.errors;
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('NATIVE_WEBVIEW_RECOVERY_PASSED');
} finally {
  if (chat.runId)
    await page.invoke('cancel_run', { runId: chat.runId, waitForCompletion: true }).catch(() => {});
  await page.button('Close window').catch(() => {});
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
