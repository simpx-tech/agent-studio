// Isolated native app -> desktop alerts name their chat and start with its reply. Direct notices
// check that Windows accepts titles and lines holding XML characters, and one opt-in real Claude
// reply finishes while Settings is open. The toasts are read back from Windows' notification
// history for this QA identity only, then cleared. Build with
// scripts/native-notification-content.tauri.json; the chime stays muted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chatNotification } from '../src/lib/notifications.ts';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.notification-content-qa';
const port = Number(process.env.NOTIFICATION_QA_PORT ?? 19741);
const executable = resolve(
  process.env.NOTIFICATION_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/notification-content';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
  })
    .toString()
    .trim();
}
const history = (call) =>
  powershell(
    `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; $history = [Windows.UI.Notifications.ToastNotificationManager]::History; ${call}`,
  );
const decode = (xml) =>
  xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
// Title and line of each toast Windows keeps in Notification Center for this identity. The
// pipeline does not enumerate the returned WinRT list, so `foreach` reads it, and base64 keeps
// the text intact through the console's code page.
function toasts() {
  const raw = history(
    `$items = $history.GetHistory('${identifier}'); $json = ConvertTo-Json -Compress -InputObject @(foreach ($toast in $items) { $toast.Content.GetXml() }); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))`,
  );
  return [JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))].flat().map((xml) => {
    const text = (id) => decode(new RegExp(`<text id="${id}">([^<]*)</text>`).exec(xml)?.[1] ?? '');
    return { title: text(1), body: text(2) };
  });
}
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
const ready = () => document.querySelector('[aria-label="New conversation"]')?.disabled === false;
async function connect() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(ready);
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
const banner = (page) =>
  page.evaluate(() => document.querySelector('.error-banner')?.textContent.trim() ?? '');
// The native side collapses whitespace and cuts overlong text itself.
const clamp = (text, limit) => {
  const words = text.split(/\s+/).filter(Boolean).join(' ');
  return Array.from(words).length <= limit
    ? words
    : `${Array.from(words)
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
};

launch();
const page = await connect();
const report = { checkedAt: new Date().toISOString() };
try {
  await sleep(3000);
  assert.equal(await banner(page), '');
  history(`$history.Clear('${identifier}')`);
  await page.invoke('set_desktop_notifications', { enabled: true, sound: false });
  const sent = async () => (await page.invoke('desktop_notification_settings')).lastSent ?? 0;

  // Text a chat can hold that toast XML must escape, and a line longer than the page sends.
  const direct = {
    kind: 'complete',
    conversationId: crypto.randomUUID(),
    tag: `${crypto.randomUUID()}:terminal`,
    title: 'QA <toast> & "quotes" 🙂',
    body: `Done. Handles <xml/> & 'apostrophes'. ${'More reply text follows. '.repeat(12)}`,
  };
  const before = await sent();
  await page.invoke('desktop_notification', { notice: direct });
  const status = await page.invoke('desktop_notification_settings');
  assert.equal(status.lastError, undefined);
  assert(status.lastSent > before);
  // Later question calls and MCP input requests are named by their UUID.
  const elicitation = {
    kind: 'attention',
    conversationId: direct.conversationId,
    tag: `${crypto.randomUUID()}:elicitation:${crypto.randomUUID()}`,
    title: 'QA elicitation',
    body: 'github requests your input.',
  };
  await page.invoke('desktop_notification', { notice: elicitation });
  await assert.rejects(
    page.invoke('desktop_notification', {
      notice: { kind: 'test', tag: `test:${crypto.randomUUID()}`, title: 'Injected' },
    }),
  );
  let shown = toasts();
  const expected = [
    { title: direct.title, body: clamp(direct.body, 180) },
    { title: elicitation.title, body: elicitation.body },
  ];
  for (const toast of expected)
    assert.deepEqual(
      shown.find((t) => t.title === toast.title),
      toast,
    );
  report.direct = expected;

  // One real Claude reply in a disposable folder, finishing while Settings is open.
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  let connection = workspace.fleet.connections.find(
    (c) =>
      c.environmentId === identity.id &&
      c.profile === 'existing' &&
      workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === 'claude',
  );
  if (!connection) {
    const account = { id: crypto.randomUUID(), provider: 'claude', name: 'Notification QA' };
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
    title: `Notification QA ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider: 'claude',
      model: 'sonnet',
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: {
      computerId: identity.computerId,
      environmentId: identity.id,
      path: await mkdtemp(join(tmpdir(), 'studio-notification-content-')),
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
    await page.evaluate(() => (window.notificationQaReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.notificationQaReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    await sleep(3000);
    assert.equal(await banner(page), '');
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
  }, 'Do not use any tools. Reply with exactly these two lines of Markdown and nothing else:\n## Check\nThe **notification** names `this` chat.');
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  const beforeReply = await sent();
  await page.button('Send message');
  // Alerts for the chat on screen stay quiet, so read Settings while it replies.
  await page.button('Settings');
  const deadline = Date.now() + 180_000;
  let reply;
  for (;;) {
    reply = (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.findLast((m) => m.role === 'assistant');
    if (reply && reply.status !== 'running' && (await sent()) > beforeReply) break;
    assert(Date.now() < deadline, 'The reply or its alert timed out');
    await sleep(500);
  }
  assert.equal(reply.status, 'complete', reply.error);
  assert.equal((await page.invoke('desktop_notification_settings')).lastError, undefined);
  const want = chatNotification('complete', chat, reply);
  await sleep(1000);
  shown = toasts();
  const toast = shown.find((t) => t.title === chat.title);
  assert.deepEqual(toast, want);
  assert.doesNotMatch(toast.body, /\*\*|##|`/);
  report.reply = {
    markdown: reply.blocks.flatMap((b) => (b.type === 'markdown' ? [b.text] : [])).join('\n\n'),
    toast,
  };
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    history(`$history.Clear('${identifier}')`);
    await page.button('Close window');
  } finally {
    page.close();
  }
}
process.exit(0);
