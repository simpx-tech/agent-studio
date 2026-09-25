// Opt-in real Claude/Codex replies in an isolated native app: conversations reply at the same
// time, including two chats of one Claude account, and stopping one leaves the others running.
// Build with scripts/native-concurrent-chats.tauri.json. No credentials are copied; each chat
// works in its own disposable folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.concurrent-chats-qa';
const port = Number(process.env.CONCURRENT_QA_PORT ?? 19711);
const executable = resolve(
  process.env.CONCURRENT_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/concurrent-chats';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

const chats = [
  {
    key: 'long',
    provider: 'claude',
    prompt:
      'This is a disposable test folder. Run exactly one shell command in the foreground, not in the background: `sleep 60`. When it has finished, reply exactly: LONG DONE',
  },
  {
    key: 'codex',
    provider: 'codex',
    prompt:
      'This is a disposable test folder. Run exactly one shell command and allow it up to 90 seconds: `Start-Sleep -Seconds 30`. When it has finished, reply exactly: CODEX DONE',
  },
  {
    key: 'quick',
    provider: 'claude',
    prompt: 'Do not use any tools. Reply exactly: QUICK DONE',
  },
];
// Queued in the Codex chat while it replies, then sent while another chat is open.
const codexFollowUp = 'Do not use any tools. Reply exactly: CODEX FOLLOW-UP DONE';

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
const report = { checkedAt: new Date().toISOString(), chats: {} };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
try {
  const identity = await page.invoke('get_installation');
  // A first launch saves its workspace once startup detection finishes.
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Concurrent QA')),
    'Use only a disposable Concurrent Chats QA workspace.',
  );
  const connection = (provider) => {
    const existing = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === identity.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider,
    );
    if (existing) return existing.id;
    const account = { id: crypto.randomUUID(), provider, name: `Concurrent QA ${provider}` };
    const created = {
      id: crypto.randomUUID(),
      accountId: account.id,
      environmentId: identity.id,
      profile: 'existing',
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(created);
    return created.id;
  };
  for (const chat of chats) {
    const now = new Date().toISOString();
    chat.id = crypto.randomUUID();
    chat.title = `Concurrent QA ${chat.key} ${Date.now()}`;
    workspace.conversations.push({
      id: chat.id,
      title: chat.title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider: chat.provider,
        model: chat.provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection(chat.provider),
      },
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: await mkdtemp(join(tmpdir(), `studio-concurrent-${chat.key}-`)),
      },
      messages: [],
    });
  }
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded app lists every chat.
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
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    for (const key of ['accounts', 'connections'])
      for (const item of workspace.fleet[key])
        if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
    for (const conversation of workspace.conversations)
      if (!current.conversations.some((c) => c.id === conversation.id))
        current.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.concurrentReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.concurrentReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    if (await listed()) break;
    assert(attempt < 5, 'The seeded chats did not survive the app reload');
    await sleep(2000);
  }
  for (const chat of chats) {
    const settings = workspace.conversations.find((c) => c.id === chat.id).settings;
    const status = await page.invoke('detect_connection', {
      provider: chat.provider,
      connectionId: settings.connectionId,
    });
    assert.equal(status.auth, 'ready', `${chat.provider} must be signed in`);
  }

  // Saved chats start in History and move to Active when they send.
  const openChat = async (chat) => {
    for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
      await page.click(tab);
      const found = await page.evaluate((title) => {
        const row = [...document.querySelectorAll('.conversation-item')].find((e) =>
          e.textContent.includes(title),
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
  };
  const type = (text) =>
    page.evaluate((text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  const send = async (chat) => {
    await openChat(chat);
    await type(chat.prompt);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    chat.sentAt = Date.now();
  };
  const text = (message) => message.blocks.map((b) => b.text ?? '').join('\n');
  const hasButton = (name) =>
    page.evaluate(
      (name) => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === name),
      name,
    );
  const waitForStop = async () => {
    const deadline = Date.now() + 30_000;
    while (!(await hasButton('Stop response'))) {
      assert(Date.now() < deadline, 'Stop response did not appear');
      await sleep(100);
    }
  };
  // Live reply states from the Active list's running indicators.
  const running = async () => {
    await page.click('#conversation-tab-active');
    return page.evaluate(
      (titles) => {
        const rows = [...document.querySelectorAll('.conversation-item')];
        return titles.map(
          (title) => !!rows.find((e) => e.title === title)?.querySelector('.pulse-dot'),
        );
      },
      chats.map((c) => c.title),
    );
  };
  const reply = async (chat) =>
    (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.findLast((m) => m.role === 'assistant');
  const settled = async (chat, timeout = 240_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const last = await reply(chat);
      if (last && last.status !== 'running') return last;
      assert(Date.now() < deadline, `${chat.key}: reply timed out`);
      await sleep(500);
    }
  };
  const [long, codex, quick] = chats;

  await send(long);
  await waitForStop();
  // The next chats send while the long reply is still running.
  await send(codex);
  await type(codexFollowUp);
  await page.waitFor(
    () => document.querySelector('[aria-label="Queue message"]')?.disabled === false,
  );
  await page.button('Queue message');
  await page.waitFor(() => !!document.querySelector('[aria-label="Queued messages"]'));
  await send(quick);
  const states = await running();
  report.runningAfterSends = Object.fromEntries(chats.map((c, i) => [c.key, states[i]]));
  assert.deepEqual(states, [true, true, true], 'all three replies run at the same time');
  await capture('three-chats-running');

  const quickReply = await settled(quick);
  assert.equal(quickReply.status, 'complete', quickReply.error);
  assert.match(quickReply.blocks.map((b) => b.text ?? '').join('\n'), /QUICK DONE/);
  const [longRunning, codexRunning] = await running();
  report.quickFinishedWhileRunning = { long: longRunning, codex: codexRunning };
  assert(longRunning, 'the same Claude account answered a second chat while the first ran');

  // Stopping one reply leaves the other conversations alone.
  await openChat(long);
  await waitForStop();
  report.codexRunningWhenLongStopped = (await running())[1];
  await page.button('Stop response');
  const longReply = await settled(long, 60_000);
  assert.equal(longReply.status, 'cancelled', longReply.error);

  // With the long chat still open, the Codex reply completes and sends its queued follow-up.
  const deadline = Date.now() + 300_000;
  let conversation, answers;
  for (;;) {
    conversation = (await page.invoke('load_workspace')).conversations.find(
      (c) => c.id === codex.id,
    );
    answers = conversation.messages.filter((m) => m.role === 'assistant');
    if (answers[0]?.status && !['running', 'complete'].includes(answers[0].status)) break;
    if (answers.length === 2 && answers[1].status !== 'running') break;
    assert(Date.now() < deadline, 'codex: the queued follow-up did not finish');
    await sleep(500);
  }
  const [codexReply, followUpReply] = answers;
  assert.equal(codexReply.status, 'complete', codexReply.error);
  assert.match(text(codexReply), /CODEX DONE/);
  assert(followUpReply, 'the queued follow-up was sent');
  assert(conversation.messages.some((m) => m.role === 'user' && text(m) === codexFollowUp));
  assert.equal(followUpReply.status, 'complete', followUpReply.error);
  assert.match(text(followUpReply), /CODEX FOLLOW-UP DONE/);
  report.openWhileFollowUpSent = await page.evaluate(
    () => document.querySelector('.conversation-item[aria-current="page"]')?.title,
  );
  assert.equal(report.openWhileFollowUpSent, long.title, 'the long chat stayed open');
  await openChat(codex);
  await capture('codex-follow-up-sent');

  const errors = [longReply, codexReply, followUpReply, quickReply]
    .map((m) => m.error ?? '')
    .filter((e) => /already responding|Another response/.test(e));
  assert.deepEqual(errors, []);
  for (const [key, provider, message] of [
    ['long', 'claude', longReply],
    ['codex', 'codex', codexReply],
    ['codexFollowUp', 'codex', followUpReply],
    ['quick', 'claude', quickReply],
  ])
    report.chats[key] = {
      provider,
      status: message.status,
      durationMs: message.durationMs,
      error: message.error,
    };
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
