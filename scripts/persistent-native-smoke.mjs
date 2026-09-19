// Run against the isolated native-persistent.tauri.json app on CDP 9517, never the user's app.
// Proves with real Claude and Codex chats that one CLI process serves consecutive replies,
// survives Stop through an in-band interrupt, and that a queued message is sent after the
// running reply completes. Writes artifacts/persistent/native-report.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const output = 'artifacts/persistent';
await mkdir(output, { recursive: true });
const page = await nativePage(9517);
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');

/**
 * Chat CLI processes launched directly by any running Agent Studio executable. Usage and
 * title queries also launch the CLIs briefly; only stream-json chats and app-server
 * threads started with the chat feature flags are conversation processes.
 */
function cliProcesses() {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress',
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).toString();
  const all = JSON.parse(raw);
  const apps = new Set(
    all.filter((p) => /^agent-studio\.exe$/i.test(p.Name ?? '')).map((p) => p.ProcessId),
  );
  return all
    .filter(
      (p) =>
        apps.has(p.ParentProcessId) &&
        /^(claude|codex)\.exe$/i.test(p.Name ?? '') &&
        /stream-json|features.shell_tool=true/.test(p.CommandLine ?? '') &&
        !/--safe-mode|\/usage/.test(p.CommandLine ?? ''),
    )
    .map((p) => ({ pid: p.ProcessId, name: p.Name.toLowerCase() }));
}
const cliPids = (provider) =>
  cliProcesses()
    .filter((p) => p.name === `${provider}.exe`)
    .map((p) => p.pid)
    .sort();

async function select(chat) {
  for (const tab of ['Active', 'History']) {
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll('[role="tab"]')]
          .find((e) => e.textContent.includes(name))
          ?.click(),
      tab,
    );
    const found = await page.evaluate((title) => {
      const el = [...document.querySelectorAll('.conversation-item')].find((e) =>
        e.textContent.includes(title),
      );
      el?.click();
      return !!el;
    }, chat.title);
    if (found) return;
  }
  throw new Error(`Chat unavailable: ${chat.title}`);
}
async function lastMessage(chat) {
  const w = await page.invoke('load_workspace');
  return w.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
}
async function waitReply(chat, expected = 'complete', timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = await lastMessage(chat);
    if (m?.role === 'assistant' && m.status !== 'running') {
      assert.equal(m.status, expected, m.error);
      return { text: text(m), status: m.status, elapsedMs: Date.now() - start };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native reply timed out');
}
async function type(prompt) {
  await page.evaluate((prompt) => {
    const el = document.querySelector('[aria-label="Message"]');
    el.value = prompt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
}
async function submit(chat, prompt, expected = 'complete') {
  await select(chat);
  await type(prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  return waitReply(chat, expected);
}
async function waitStreaming(chat) {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const m = await lastMessage(chat);
    if (m?.role === 'assistant' && m.status === 'running') {
      const streamed = await page.evaluate(
        () => ([...document.querySelectorAll('.message')].at(-1)?.innerText ?? '').length > 200,
      );
      if (streamed) return;
    }
    if (m?.role === 'assistant' && m.status !== 'running')
      throw new Error(`Reply ended before streaming could be observed: ${m.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('No streamed output');
}

const longTask =
  'Write the numbers from 1 to 120, one per line, each followed by a short unique sentence. Do not use tools.';

try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.persistent-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Persistent QA')),
    'Not a disposable workspace',
  );
  const report = { checkedAt: new Date().toISOString(), chats: [] };
  for (const provider of ['claude', 'codex']) {
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `Missing ${provider} connection`);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const folder = await mkdtemp(join(tmpdir(), `studio-persistent-${provider}-`));
    const title = `Persistent QA ${provider} ${id.slice(0, 8)}`;
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      messages: [],
    });
    report.chats.push({ id, provider, title, folder });
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.persistentReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.persistentReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const save = () => writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  for (const chat of report.chats) {
    const { provider } = chat;
    // Other conversations may hold parked processes; track only this chat's new one.
    const before = new Set(cliPids(provider));
    chat.first = await submit(chat, 'Reply exactly READY. Do not use tools.');
    assert.equal(chat.first.text.trim(), 'READY');
    const added = cliPids(provider).filter((pid) => !before.has(pid));
    assert.equal(added.length, 1, `${provider}: one parked process after the reply: ${added}`);
    chat.pid = added[0];
    const known = new Set([...before, chat.pid]);
    const onlyReused = (label) => {
      const now = cliPids(provider);
      assert(now.includes(chat.pid), `${provider}: ${label}: parked pid ${chat.pid} is gone`);
      const extra = now.filter((pid) => !known.has(pid));
      assert.deepEqual(extra, [], `${provider}: ${label}: unexpected new process`);
    };
    console.log(
      `${provider}: first reply complete in ${chat.first.elapsedMs} ms; parked pid ${chat.pid}`,
    );

    chat.second = await submit(chat, 'Reply exactly READY2. Do not use tools.');
    assert.equal(chat.second.text.trim(), 'READY2');
    onlyReused('second reply');
    console.log(`${provider}: second reply reused pid ${chat.pid} in ${chat.second.elapsedMs} ms`);

    // Stop through the in-band interrupt keeps the process for the next reply.
    await select(chat);
    await type(longTask);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    await waitStreaming(chat);
    await page.button('Stop response');
    chat.stopped = await waitReply(chat, 'cancelled');
    onlyReused('stop');
    console.log(
      `${provider}: stop kept pid ${chat.pid}; partial text ${chat.stopped.text.length} chars`,
    );
    chat.afterStop = await submit(chat, 'Reply exactly READY3. Do not use tools.');
    assert.equal(chat.afterStop.text.trim(), 'READY3');
    onlyReused('reply after stop');

    // A message queued during a reply is sent automatically after it completes.
    await select(chat);
    await type(
      'Write the numbers from 1 to 40, one per line, each with a short sentence. Do not use tools.',
    );
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    await page.waitFor(() => !!document.querySelector('[aria-label="Queue message"]'));
    await type('Reply exactly QUEUED_OK. Do not use tools.');
    await page.waitFor(
      () => document.querySelector('[aria-label="Queue message"]')?.disabled === false,
    );
    await page.button('Queue message');
    await page.waitFor(() =>
      document.querySelector('[aria-label="Queued messages"]')?.textContent.includes('QUEUED_OK'),
    );
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/queued-${provider}.png`, Buffer.from(shot.data, 'base64'));
    chat.counting = await waitReply(chat);
    const start = Date.now();
    let final;
    while (Date.now() - start < 240000) {
      const w = await page.invoke('load_workspace');
      const messages = w.conversations.find((c) => c.id === chat.id)?.messages ?? [];
      const queuedUser = messages.findLast((m) => m.role === 'user');
      const reply = messages.at(-1);
      if (
        queuedUser &&
        text(queuedUser).includes('QUEUED_OK') &&
        reply.role === 'assistant' &&
        reply.status !== 'running'
      ) {
        final = reply;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(final, `${provider}: queued message was not sent`);
    assert.equal(final.status, 'complete', final.error);
    assert.equal(text(final).trim(), 'QUEUED_OK');
    chat.queued = { text: text(final), status: final.status };
    onlyReused('queued reply');
    assert.equal(
      await page.evaluate(() => !!document.querySelector('[aria-label="Queued messages"]')),
      false,
    );
    console.log(`${provider}: queued message sent automatically on pid ${chat.pid}`);
    await save();
  }
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native-final.png`, Buffer.from(shot.data, 'base64'));
  report.errors = page.errors;
  await save();
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
