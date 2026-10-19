// Opt-in real Codex replies in an isolated native app: a reload of the window stops nothing
// (src-tauri/src/reply_feed.rs). A reply running a shell command keeps running through the reload
// and ends in the reloaded window, and a reply waiting on a question is answered there; the chats
// stay in Active. Keys sent through CDP never reach WebView2's accelerator handling (page_guard.rs
// sees none, yet the browser reloads for them), so this driver reloads with `Page.reload`.
//
//   npm run build
//   CARGO_TARGET_DIR=<scratch> npx tauri build --debug --no-bundle --config scripts/native-reload.tauri.json
//   RELOAD_QA_EXECUTABLE=<long path of that agent-studio.exe> node scripts/reload-native-smoke.mjs
//
// No credentials are copied: the QA identity uses this computer's own Codex login, and each chat
// works in a disposable folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.reload-qa';
const port = 19881;
const executable = resolve(
  process.env.RELOAD_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/reload-native';
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
async function connect() {
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

launch();
const page = await connect();
await page.quitOnClose();
const report = { checkedAt: new Date().toISOString() };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
// Reloads the window as F5 did, and waits for the reloaded page.
const reload = async () => {
  await page.evaluate(() => (window.reloadQaPending = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.reloadQaPending &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null),
    null,
  );
};
const chats = {};
try {
  const identity = await page.invoke('get_installation');
  // A first launch saves its workspace once startup detection finishes.
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Reload QA')),
    'Use only a disposable Reload QA workspace.',
  );
  let connection = workspace.fleet.connections.find(
    (c) =>
      c.environmentId === identity.id &&
      c.profile === 'existing' &&
      workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === 'codex',
  );
  if (!connection) {
    const account = { id: crypto.randomUUID(), provider: 'codex', name: 'Reload QA codex' };
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
  // The catalog's first model, as a new chat starts with.
  const model = (catalog.codex ?? []).find((m) => m.id)?.id ?? '';
  report.model = model;
  for (const key of ['command', 'question']) {
    const now = new Date().toISOString();
    chats[key] = { id: crypto.randomUUID(), title: `Reload QA ${key} ${Date.now()}` };
    workspace.conversations.push({
      id: chats[key].id,
      title: chats[key].title,
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
        path: await mkdtemp(join(tmpdir(), `studio-reload-${key}-`)),
      },
      messages: [],
    });
  }
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded app lists every chat.
  const rows = () =>
    page.evaluate(async () => {
      const titles = [];
      for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
        document.querySelector(tab)?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (const row of document.querySelectorAll('.conversation-item'))
          titles.push({ title: row.title, tab });
      }
      return titles;
    });
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    for (const key of ['accounts', 'connections'])
      for (const item of workspace.fleet[key])
        if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
    for (const conversation of workspace.conversations)
      if (!current.conversations.some((c) => c.id === conversation.id))
        current.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace: current });
    await reload();
    const listed = (await rows()).map((r) => r.title);
    if (Object.values(chats).every((chat) => listed.includes(chat.title))) break;
    assert(attempt < 5, 'The seeded chats did not survive the reload');
    await sleep(2000);
  }
  const status = await page.invoke('detect_connection', {
    provider: 'codex',
    connectionId: connection.id,
  });
  assert.equal(status.auth, 'ready', 'Codex must be signed in on this computer');

  const openChat = async (chat) => {
    await page.evaluate(async (title) => {
      for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
        document.querySelector(tab)?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const row = [...document.querySelectorAll('.conversation-item')].find(
          (e) => e.title === title,
        );
        if (row) return row.click();
      }
    }, chat.title);
    await page.waitFor(
      (title) => document.querySelector('.conversation-item[aria-current="page"]')?.title === title,
      chat.title,
    );
  };
  const send = async (chat, text) => {
    await openChat(chat);
    await page.evaluate((text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
  };
  const reply = async (chat) =>
    (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.findLast((m) => m.role === 'assistant');
  const until = async (chat, ready, what, timeout = 240_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const last = await reply(chat);
      if (last && ready(last)) return last;
      assert(last?.status !== 'error', `${what}: ${last?.error}`);
      assert(Date.now() < deadline, `${what} timed out`);
      await sleep(500);
    }
  };
  const answer = (message) =>
    message.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('\n');
  const stopShown = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('button')].some(
        (b) => (b.getAttribute('aria-label') ?? b.innerText).trim() === 'Stop response',
      ),
    );

  // A reply running a shell command when the window reloads runs on and ends there.
  const command = chats.command;
  await send(
    command,
    'This is a disposable test folder. Run exactly one shell command in the foreground and allow it up to 120 seconds: `Start-Sleep -Seconds 25`. When it has finished, reply exactly: RELOAD COMMAND DONE',
  );
  // A running call reaches the disk with a later save, so the live reply shows when it starts.
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
  const running = await reply(command);
  assert.equal(running.status, 'running', running.error);
  command.runId = running.runId;
  report.liveBeforeReload = await page.invoke('live_runs');
  assert(report.liveBeforeReload.some((run) => run.runId === command.runId));
  await capture('command-before-reload');
  await reload();
  const after = await reply(command);
  report.commandAfterReload = { status: after.status, error: after.error ?? null };
  assert.equal(after.status, 'running', after.error);
  const workspaceAfter = await page.invoke('load_workspace');
  assert(
    !workspaceAfter.conversations.find((c) => c.id === command.id).archived,
    'the reload kept the chat in Active',
  );
  assert(
    (await rows()).some((r) => r.title === command.title && r.tab === '#conversation-tab-active'),
  );
  await openChat(command);
  await page.waitFor(() =>
    [...document.querySelectorAll('button')].some(
      (b) => (b.getAttribute('aria-label') ?? b.innerText).trim() === 'Stop response',
    ),
  );
  await capture('command-after-reload');
  const commandDone = await until(command, (m) => m.status !== 'running', 'the command reply');
  report.command = {
    status: commandDone.status,
    error: commandDone.error ?? null,
    answer: answer(commandDone),
    calls: commandDone.blocks.filter((b) => b.tool).map((b) => [b.tool.command, b.tool.status]),
    durationMs: commandDone.durationMs,
  };
  assert.equal(commandDone.status, 'complete', commandDone.error);
  assert.match(answer(commandDone), /RELOAD COMMAND DONE/);
  assert(commandDone.blocks.some((b) => b.tool?.command && b.tool.status === 'complete'));
  assert(!(await stopShown()), 'the followed reply ended in the reloaded window');
  await capture('command-done');

  // A reply waiting on a question when the window reloads is answered in the reloaded window.
  const question = chats.question;
  await send(
    question,
    'Call the studio_ask_user tool exactly once to ask which color I prefer, with the choices Red and Blue. Wait for my answer. Then reply exactly: COLOR <my answer in capitals>. Do not run any other tool.',
  );
  const asking = await until(
    question,
    (m) => m.questions?.some((q) => q.status === 'pending'),
    'the question',
  );
  question.runId = asking.runId;
  await reload();
  assert.equal((await reply(question)).status, 'running');
  await openChat(question);
  await page.waitFor(() => !!document.querySelector('.question-card.active input'));
  await capture('question-after-reload');
  await page.evaluate(() => {
    const option = [...document.querySelectorAll('.question-card .question-option')].find((e) =>
      e.textContent.includes('Blue'),
    );
    option.querySelector('input').click();
  });
  await page.button('Send answers');
  const answered = await until(question, (m) => m.status !== 'running', 'the answered reply');
  report.question = {
    status: answered.status,
    error: answered.error ?? null,
    answer: answer(answered),
  };
  assert.equal(answered.status, 'complete', answered.error);
  assert.match(answer(answered), /COLOR BLUE/);
  await capture('question-done');

  // Both replies ended in the reloaded window, which took their ends.
  report.liveAtEnd = await page.invoke('live_runs');
  assert.deepEqual(report.liveAtEnd, []);
  report.rendererErrors = page.errors;
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('NATIVE_RELOAD_KEEPS_REPLIES_PASSED');
} finally {
  for (const chat of Object.values(chats))
    if (chat.runId)
      await page
        .invoke('cancel_run', { runId: chat.runId, waitForCompletion: true })
        .catch(() => {});
  await page.button('Close window').catch(() => {});
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
