// Isolated native app -> a call the window sends twice runs once (docs/DIAGNOSTICS.md). A real
// reply whose `run_agent` fetch fails partway, as every call in flight did on 2026-10-11, is sent
// again by Tauri through postMessage and still finishes as one reply; the page records the move
// as an ipcFallback report; and images still store and read back through postMessage. Build with
// scripts/native-ipc-replay.tauri.json and pass the executable in IPC_REPLAY_QA_EXECUTABLE. The
// reply uses the first signed-in Codex or Claude login on this computer, in a disposable folder.
// IPC_REPLAY_QA_KILL=network fails the fetch the way it may have failed then instead, by ending
// the QA app's WebView2 network service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.ipc-replay-qa';
const port = 19831;
const executable = resolve(
  process.env.IPC_REPLAY_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const kill = process.env.IPC_REPLAY_QA_KILL === 'network';
const data = join(process.env.LOCALAPPDATA, identifier);
const diagnostics = join(data, 'diagnostics');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name) => console.error(`${new Date().toISOString()} ${name}`);
// The smallest PNG: a 1x1 grayscale pixel.
const png = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 0, 0, 0, 0, 0x3a, 0x7e, 0x9b, 0x55, 0, 0, 0, 10, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1, 0xe5, 0x27, 0xde, 0xfc, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
];

const powershell = (args) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    windowsHide: true,
  })
    .toString()
    .trim();
// Only processes of this QA executable, matched by their full path.
const running = () =>
  powershell([
    '-Command',
    `@(Get-Process agent-studio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable.replace(/'/g, "''")}' } | ForEach-Object { $_.Id }) -join ','`,
  ])
    .split(',')
    .filter(Boolean)
    .map(Number);
// The QA identity's own WebView2 network service, never another app's.
const networkService = () =>
  powershell([
    '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*\\${identifier}\\EBWebView*' -and $_.CommandLine -like '*network.mojom.NetworkService*' } | ForEach-Object { $_.ProcessId }) -join ','`,
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
const reports = async (kind) =>
  (await readdir(diagnostics).catch(() => [])).filter((name) => name.endsWith(`-${kind}.json`));

assert.deepEqual(running(), [], 'Quit the IPC replay QA app before running this driver.');
await rm(data, { recursive: true, force: true });
const report = {
  checkedAt: new Date().toISOString(),
  executable,
  trigger: kill ? 'network' : 'fetch',
};
let page;
let pid;
try {
  const started = JSON.parse(
    powershell([
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-windows.ps1',
      '-Executable',
      executable,
    ]),
  );
  assert.equal(started.status, 'started', JSON.stringify(started));
  pid = started.processId;
  const connect = () =>
    until(
      async () => {
        try {
          const page = await nativePage(port);
          assert.equal(await page.invoke('plugin:app|identifier'), identifier);
          await page.waitFor(
            () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
          );
          return page;
        } catch {
          return undefined;
        }
      },
      'The QA app did not open its page.',
      60_000,
    );
  page = await connect();
  step('connected');
  await page.quitOnClose();

  // One disposable chat for each provider, kept through the reload that shows them.
  const identity = await page.invoke('get_installation');
  step('installation read');
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  step('workspace read');
  const chats = [];
  for (const provider of ['codex', 'claude']) {
    let connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === identity.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider,
    );
    if (!connection) {
      const account = { id: crypto.randomUUID(), provider, name: `IPC replay QA ${provider}` };
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
      provider,
      connectionId: connection.id,
      title: `IPC replay QA ${provider} ${Date.now()}`,
    };
    chats.push(chat);
    workspace.conversations.push({
      id: chat.id,
      title: chat.title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model: '',
        reasoning: '',
        instructions: '',
        connectionId: connection.id,
      },
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: await mkdtemp(join(tmpdir(), `studio-ipc-replay-${provider}-`)),
      },
      messages: [],
    });
  }
  const listed = () =>
    page.evaluate(
      async (titles) => {
        document.querySelector('#conversation-tab-history')?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const rows = [...document.querySelectorAll('.conversation-item')].map((e) => e.title);
        return titles.every((title) => rows.includes(title));
      },
      chats.map((c) => c.title),
    );
  // A save the app started during startup detection can land after this one: seed again until
  // the reloaded app lists both chats.
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    for (const key of ['accounts', 'connections'])
      for (const item of workspace.fleet[key])
        if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
    for (const conversation of workspace.conversations)
      if (!current.conversations.some((c) => c.id === conversation.id))
        current.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.replayReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.replayReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    step(`seeded, attempt ${attempt}`);
    if (await listed()) break;
    assert(attempt < 5, 'The seeded chats did not survive the app reload');
    await sleep(2000);
  }
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );
  let chat;
  for (const candidate of chats) {
    const status = await page.invoke('detect_connection', {
      provider: candidate.provider,
      connectionId: candidate.connectionId,
    });
    if (status.auth === 'ready') {
      chat = candidate;
      break;
    }
  }
  assert(chat, 'Sign in to Codex or Claude Code in a terminal first.');
  report.provider = chat.provider;
  step(`replying with ${chat.provider}`);

  // Each IPC fetch is counted, and the reply's own can be made to fail while the app runs it.
  await page.evaluate(() => {
    const real = window.fetch;
    window.ipcFetches = 0;
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('http://ipc.localhost/')) return real(input, init);
      window.ipcFetches++;
      const answer = real(input, init);
      if (!url.startsWith('http://ipc.localhost/run_agent')) return answer;
      return new Promise((resolve, reject) => {
        window.failReply = () => reject(new TypeError('Failed to fetch'));
        answer.then(resolve, reject);
      });
    };
  });

  for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
    await page.click(tab);
    const found = await page.evaluate((title) => {
      const row = [...document.querySelectorAll('.conversation-item')].find(
        (e) => e.title === title,
      );
      row?.click();
      return !!row;
    }, chat.title);
    if (found) break;
  }
  await page.waitFor(
    (title) => document.querySelector('.conversation-item[aria-current="page"]')?.title === title,
    chat.title,
  );
  const command = chat.provider === 'codex' ? 'Start-Sleep -Seconds 25' : 'sleep 25';
  await page.evaluate((text) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, `This is a disposable test folder. Run exactly one shell command in the foreground, not in the background, and allow it up to 90 seconds: \`${command}\`. When it has finished, reply exactly: REPLAY DONE`);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  step('sent');
  await until(
    () =>
      page.evaluate(() =>
        [...document.querySelectorAll('button')].some(
          (b) => (b.getAttribute('aria-label') ?? b.innerText).trim() === 'Stop response',
        ),
      ),
    'The reply did not start.',
  );
  await until(
    () => page.evaluate(() => typeof window.failReply === 'function'),
    'The reply did not call run_agent.',
  );
  // Partway through the reply, while its CLI runs the command.
  await sleep(10_000);
  if (kill) {
    const [service] = networkService();
    assert(service, 'The QA app has no network service process.');
    powershell(['-Command', `Stop-Process -Id ${service} -Force`]);
    report.endedNetworkService = service;
  } else await page.evaluate(() => window.failReply());
  const failedAt = Date.now();
  step('fetch failed');

  const reply = async () =>
    (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.findLast((m) => m.role === 'assistant');
  const settled = await until(
    async () => {
      const last = await reply();
      return last && last.status !== 'running' ? last : undefined;
    },
    'The reply did not finish.',
    240_000,
  );
  const answer = settled.blocks.map((b) => b.text ?? '').join('\n');
  report.reply = {
    status: settled.status,
    error: settled.error,
    finishedAfterFailureMs: Date.now() - failedAt,
    answered: /REPLAY DONE/.test(answer),
  };
  assert.equal(settled.status, 'complete', settled.error);
  assert.match(answer, /REPLAY DONE/);
  step('reply complete');

  // The move to postMessage is on record, with the reply's call among those sent again.
  const [fallbackName] = await until(() => reports('ipcFallback'), 'No ipcFallback report.');
  const fallback = JSON.parse(await readFile(join(diagnostics, fallbackName), 'utf8'));
  report.ipcFallback = fallback;
  assert.equal(fallback.kind, 'ipcFallback');
  if (!kill) assert.equal(fallback.error, 'TypeError: Failed to fetch');
  assert(fallback.calls.some((call) => call.command === 'run_agent'));
  if (kill) {
    // WebView2 itself names the process that failed.
    const [name] = await until(() => reports('webviewProcess'), 'No webviewProcess report.');
    report.webviewProcess = JSON.parse(await readFile(join(diagnostics, name), 'utf8')).process;
    assert.equal(report.webviewProcess.kind, 'utilityProcessExited');
    assert.equal(report.webviewProcess.description, 'Network Service');
  }

  // Calls now go through postMessage: none fetches, and image bytes still arrive whole.
  const before = await page.evaluate(() => window.ipcFetches);
  const kept = await page.evaluate(
    (bytes) => window.__TAURI_INTERNALS__.invoke('store_chat_image', new Uint8Array(bytes)),
    png,
  );
  assert.equal(kept.mediaType, 'image/png');
  assert.equal(kept.bytes, png.length);
  const read = await page.evaluate(async (hash) => {
    const answer = await window.__TAURI_INTERNALS__.invoke('read_chat_image', { hash });
    return {
      kind: answer instanceof ArrayBuffer ? 'buffer' : Array.isArray(answer) ? 'numbers' : 'other',
      bytes: [...new Uint8Array(answer instanceof ArrayBuffer ? answer : Uint8Array.from(answer))],
    };
  }, kept.hash);
  assert.deepEqual(read.bytes, png);
  assert.equal(await page.evaluate(() => window.ipcFetches), before);
  report.images = { kept, readBackAs: read.kind };

  await page.button('Close window');
  await until(async () => !running().includes(pid), 'The QA app did not quit.', 30_000);
  pid = undefined;
  console.log(JSON.stringify({ ...report, passed: true }, null, 2));
} catch (error) {
  if (page) {
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' }).catch(() => undefined);
    if (shot) {
      await mkdir('artifacts/ipc-replay', { recursive: true });
      await writeFile('artifacts/ipc-replay/failure.png', Buffer.from(shot.data, 'base64'));
    }
  }
  throw error;
} finally {
  page?.close();
  if (pid)
    try {
      powershell(['-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
    } catch {
      // It has already ended.
    }
  await until(async () => running().length === 0, 'The QA app is still running.', 30_000).catch(
    () => {},
  );
  await rm(data, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
