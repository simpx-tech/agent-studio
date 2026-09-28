// Isolated native app -> closing the window keeps Agent Studio in the system tray: the window
// hides while the process runs, the tray icon and its menu bring it back, a second launch
// shows it instead of starting another copy, Settings turns the behavior off and on, and Quit
// in the tray menu ends the app. With --reply, one real Claude reply runs while the window is
// hidden and its alert is read back from Windows' notification history for this QA identity.
// Build with scripts/native-tray.tauri.json and pass the executable in TRAY_QA_EXECUTABLE; the
// driver deletes the QA identity's data folder before and after the run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.tray-qa';
const port = 19751;
const executable = resolve(
  process.env.TRAY_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const data = join(process.env.LOCALAPPDATA, identifier);
const output = 'artifacts/tray';
const withReply = process.argv.includes('--reply');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

const powershell = (args) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    windowsHide: true,
  })
    .toString()
    .trim();
const script = (file, ...args) =>
  powershell(['-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const helper = (action, pid) => {
  const text = script('scripts/tray-native-helper.ps1', '-Action', action, '-QAProcessId', pid);
  return text ? JSON.parse(text) : undefined;
};
const launch = (...args) =>
  JSON.parse(script('scripts/start-windows.ps1', '-Executable', executable, ...args));
// Only processes of this QA executable, matched by their full path.
const running = () =>
  powershell([
    '-Command',
    `@(Get-Process agent-studio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable.replace(/'/g, "''")}' } | ForEach-Object { $_.Id }) -join ','`,
  ])
    .split(',')
    .filter(Boolean)
    .map(Number);
async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, message);
    await sleep(250);
  }
}
const history = (call) =>
  powershell([
    '-Command',
    `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; $history = [Windows.UI.Notifications.ToastNotificationManager]::History; ${call}`,
  ]);
function toastTitles() {
  const raw = history(
    `$json = ConvertTo-Json -Compress -InputObject @(foreach ($toast in $history.GetHistory('${identifier}')) { $toast.Content.GetXml() }); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))`,
  );
  return [JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))]
    .flat()
    .filter(Boolean)
    .map((xml) => /<text id="1">([^<]*)<\/text>/.exec(xml)?.[1] ?? '');
}
const ready = () => document.querySelector('[aria-label="New conversation"]')?.disabled === false;
async function start() {
  const started = launch();
  assert.equal(started.status, 'started', JSON.stringify(started));
  const pid = String(started.processId);
  const page = await until(
    async () => {
      try {
        const page = await nativePage(port);
        assert.equal(await page.invoke('plugin:app|identifier'), identifier);
        await page.waitFor(ready);
        return page;
      } catch {
        return undefined;
      }
    },
    'The QA app did not open its page.',
    60_000,
  );
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );
  return { pid, page };
}
const hidden = async (pid) => {
  const state = helper('State', pid);
  return state.running && state.window && !state.visible && state;
};
const shown = async (pid) => {
  const state = helper('State', pid);
  return state.running && state.visible && state;
};
const exited = (pid) => async () => !helper('State', pid).running;
async function closeFromTitlebar(page, pid) {
  await page.button('Close window');
  return await until(() => hidden(pid), 'Closing did not hide the window.', 10_000);
}
const savedSetting = async () => JSON.parse(await readFile(join(data, 'tray.json'), 'utf8'));

// A clean identity starts with the default choice.
assert.deepEqual(running(), [], 'Quit the tray QA app before running this driver.');
await rm(data, { recursive: true, force: true });
const report = { checkedAt: new Date().toISOString(), executable };
let app;
let folder;
try {
  app = await start();
  let { pid, page } = app;
  assert.deepEqual(await page.invoke('window_behavior'), {
    closeToTray: true,
    area: 'tray',
    clickOpens: true,
  });
  assert.equal(helper('State', pid).tray, true, 'The tray icon was not added.');
  report.defaultOn = true;

  if (withReply) {
    // One real Claude reply that finishes while the window is hidden in the tray.
    history(`$history.Clear('${identifier}')`);
    await page.invoke('set_desktop_notifications', { enabled: true, sound: false });
    const identity = await page.invoke('get_installation');
    const workspace = await page.invoke('load_workspace');
    let connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === identity.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === 'claude',
    );
    if (!connection) {
      const account = { id: crypto.randomUUID(), provider: 'claude', name: 'Tray QA' };
      connection = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push(connection);
    }
    const now = new Date().toISOString();
    const chat = {
      id: crypto.randomUUID(),
      title: `Tray QA ${Date.now()}`,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider: 'claude',
        model: 'haiku',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: (folder = await mkdtemp(join(tmpdir(), 'studio-tray-'))),
      },
      messages: [],
    };
    // A save the app started during startup detection can land after this one, so seed again
    // until the reloaded app lists the chat.
    for (let attempt = 1; ; attempt++) {
      const current = await page.invoke('load_workspace');
      for (const key of ['accounts', 'connections'])
        for (const item of workspace.fleet[key])
          if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
      if (!current.conversations.some((c) => c.id === chat.id)) current.conversations.push(chat);
      await page.invoke('save_workspace', { workspace: current });
      await page.evaluate(() => (window.trayQaReload = true));
      await page.cdp('Page.reload');
      await page.waitFor(
        () =>
          !window.trayQaReload &&
          document.querySelector('[aria-label="New conversation"]')?.disabled === false,
      );
      await sleep(3000);
      const listed = await page.evaluate(async (title) => {
        document.querySelector('#conversation-tab-history')?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [...document.querySelectorAll('.conversation-item')].some((e) => e.title === title);
      }, chat.title);
      if (listed) break;
      assert(attempt < 5, 'The seeded chat did not survive the app reload');
    }
    const login = await page.invoke('detect_connection', {
      provider: 'claude',
      connectionId: connection.id,
    });
    assert.equal(login.auth, 'ready', 'Claude must be signed in');
    await page.evaluate((title) => {
      [...document.querySelectorAll('.conversation-item')].find((e) => e.title === title).click();
    }, chat.title);
    await page.waitFor(
      (title) => document.querySelector('.conversation-item[aria-current="page"]')?.title === title,
      chat.title,
    );
    await page.evaluate((text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'Do not use any tools. Count from 1 to 30, one number per line, then write the word done.');
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    const sentBefore = (await page.invoke('desktop_notification_settings')).lastSent ?? 0;
    await page.button('Send message');
    // Close the window as soon as the reply is under way.
    await page.waitFor(() => !!document.querySelector('.stop-button'));
    await closeFromTitlebar(page, pid);
    const reply = await until(
      async () => {
        const message = (await page.invoke('load_workspace')).conversations
          .find((c) => c.id === chat.id)
          ?.messages.findLast((m) => m.role === 'assistant');
        return message && message.status !== 'running' && message;
      },
      'The reply did not finish while the window was hidden.',
      180_000,
    );
    assert.equal(reply.status, 'complete', reply.error);
    assert.equal((await hidden(pid)) !== false, true, 'The window reappeared during the reply.');
    const settings = await until(async () => {
      const value = await page.invoke('desktop_notification_settings');
      return (value.lastSent ?? 0) > sentBefore && value;
    }, 'No alert was sent for the hidden window.');
    assert.equal(settings.lastError, undefined);
    await sleep(1000);
    assert(toastTitles().includes(chat.title), 'Windows did not keep the reply alert.');
    helper('Click', pid);
    await until(() => shown(pid), 'The tray click did not show the window.');
    const text = await page.evaluate(() => document.querySelector('.chat-scroll')?.innerText ?? '');
    assert.match(text, /\bdone\b/i);
    report.replyWhileHidden = { status: reply.status, alert: chat.title };
  }

  // Closing hides the window, which loses focus, so alerts are not suppressed as read.
  const closed = await closeFromTitlebar(page, pid);
  assert.equal(closed.tray, true);
  assert.equal(await page.evaluate(() => document.hasFocus()), false);
  assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), false);
  report.closeHides = true;

  helper('Click', pid);
  await until(() => shown(pid), 'A left click on the tray icon did not show the window.');
  report.clickShows = true;

  await closeFromTitlebar(page, pid);
  report.menu = helper('Open', pid).menu;
  assert.deepEqual(report.menu, ['Open Agent Studio', '', 'Quit Agent Studio']);
  await until(() => shown(pid), 'Open Agent Studio did not show the window.');

  // Launching again shows the running window instead of starting a second copy.
  await closeFromTitlebar(page, pid);
  const second = launch('-SecondInstance');
  assert.equal(second.status, 'handed-over');
  assert.equal(second.exitCode, 0);
  report.secondLaunch = await until(
    () => shown(pid),
    'A second launch did not show the running window.',
  );
  assert.deepEqual(running(), [Number(pid)]);

  // Settings turns the tray off and on for this computer.
  await page.button('Settings');
  const toggle = () =>
    page.evaluate(() => {
      const box = [...document.querySelectorAll('input[type="checkbox"]')].find((input) =>
        input.closest('label')?.textContent.includes('Keep running in the system tray'),
      );
      box.click();
    });
  const summary = () =>
    page.evaluate(
      () =>
        document.querySelector('[aria-labelledby="background-heading"] [role="status"]')
          ?.textContent ?? '',
    );
  await page.waitFor(() => !!document.querySelector('[aria-labelledby="background-heading"]'));
  await page.evaluate(() =>
    document.querySelector('[aria-labelledby="background-heading"]').scrollIntoView(),
  );
  const rect = await page.evaluate(() => {
    const r = document
      .querySelector('[aria-labelledby="background-heading"]')
      .getBoundingClientRect();
    return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
  });
  const { data: png } = await page.cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { ...rect, scale: 1 },
  });
  await writeFile(`${output}/native-settings.png`, Buffer.from(png, 'base64'));
  await toggle();
  await until(
    async () => (await summary()).startsWith('Closing the window quits'),
    'Turning the tray off did not update Settings.',
  );
  await until(async () => !helper('State', pid).tray, 'The tray icon stayed after turning off.');
  assert.deepEqual(await savedSetting(), { closeToTray: false });
  await toggle();
  await until(async () => helper('State', pid).tray, 'The tray icon did not come back.');
  assert.deepEqual(await savedSetting(), { closeToTray: true });
  report.settingsToggle = true;

  // Quit in the tray menu ends the app.
  const quitAt = Date.now();
  helper('Quit', pid);
  await until(exited(pid), 'Quit Agent Studio did not end the app.', 30_000);
  report.quitSeconds = (Date.now() - quitAt) / 1000;
  page.close();

  // With the tray turned off, closing the window quits as before, and the choice persists.
  app = await start();
  ({ pid, page } = app);
  assert.equal((await page.invoke('window_behavior')).closeToTray, true);
  const off = await page.invoke('set_close_to_tray', { enabled: false });
  assert.equal(off.closeToTray, false);
  await until(async () => !helper('State', pid).tray, 'The tray icon stayed after turning off.');
  await page.button('Close window');
  await until(exited(pid), 'Closing with the tray off did not quit.', 30_000);
  page.close();
  report.closeQuitsWhenOff = true;

  app = await start();
  ({ pid, page } = app);
  assert.equal((await page.invoke('window_behavior')).closeToTray, false);
  assert.equal(helper('State', pid).tray, false);
  await page.invoke('set_close_to_tray', { enabled: true });
  await until(async () => helper('State', pid).tray, 'Turning the tray on did not add its icon.');
  helper('Quit', pid);
  await until(exited(pid), 'Quit Agent Studio did not end the app.', 30_000);
  page.close();
  report.choicePersists = true;
  app = undefined;

  assert.deepEqual(running(), []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app && helper('State', app.pid).running) {
    try {
      if (helper('State', app.pid).tray) helper('Quit', app.pid);
      else await app.page.button('Close window');
      await until(exited(app.pid), 'The QA app did not quit.', 30_000);
    } finally {
      app.page.close();
    }
  }
  if (withReply) {
    // Enabling notifications registered this QA identity to show its alerts.
    const key = `HKCU:\\Software\\Classes\\AppUserModelId\\${identifier}`;
    try {
      history(`$history.Clear('${identifier}')`);
      powershell([
        '-Command',
        `if (Test-Path '${key}') { Remove-Item -LiteralPath '${key}' -Recurse }`,
      ]);
    } catch (error) {
      console.error(`Remove ${key} and this identity's notifications by hand: ${error.message}`);
    }
  }
  if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
  await rm(data, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
