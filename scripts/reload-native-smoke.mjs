import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { nativePage } from './native-page.mjs';

const appPid = Number(process.env.QA_NATIVE_PID);
assert(Number.isSafeInteger(appPid) && appPid > 0, 'Set QA_NATIVE_PID to the isolated app process');
const children = () =>
  JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${appPid}" | Where-Object { $_.Name -eq 'claude.exe' } | Select-Object -ExpandProperty ProcessId)`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
const page = await nativePage(9501, 'http://127.0.0.1:1430/');
await mkdir('artifacts', { recursive: true });
let originalRun;
const reload = async () => {
  await page.evaluate(() => (window.reloadQaPending = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.reloadQaPending &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false &&
      document.querySelector('#conversation-tab-history'),
  );
};
const openHistoryChat = async (title) => {
  await page.click('#conversation-tab-history');
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((e) =>
        e.textContent.includes(title),
      ),
    title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    title,
  );
};
const send = async (text) => {
  await page.evaluate((text) => {
    const field = document.querySelector('[aria-label="Message"]');
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
};
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.reload-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Reload QA')),
    'Not a disposable workspace',
  );
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.profile === 'existing' &&
      c.environmentId === identity.id &&
      workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === 'claude'),
  );
  assert(connection, 'Existing Claude login unavailable');
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'claude', connectionId: connection.id }))
      .auth,
    'ready',
  );
  const id = crypto.randomUUID(),
    now = new Date().toISOString(),
    title = `Reload QA ${id.slice(0, 8)}`;
  workspace.conversations.push({
    id,
    title,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider: 'claude',
      model: 'opus',
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: '' },
    messages: [],
  });
  await page.invoke('save_workspace', { workspace });
  await reload();
  await openHistoryChat(title);
  const readReply = async () =>
    (await page.invoke('load_workspace')).conversations.find((c) => c.id === id)?.messages.at(-1);
  await send(
    'Call the actual mcp__agent_studio__studio_ask_user tool exactly once to ask my preferred color with Red and Blue choices. Wait for my explicit answer. Do not use shell commands, files, web or subagents.',
  );
  let reply;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    reply = await readReply();
    if (reply?.questions?.some((q) => q.status === 'pending') || reply?.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(reply?.status, 'running', reply?.error);
  assert(
    reply.questions?.some((q) => q.status === 'pending'),
    'Provider did not ask a question',
  );
  originalRun = reply.runId;
  const before = children();
  assert.equal(before.length, 1, 'Expected one owned Claude process waiting for input');
  await page.waitFor(() => !!document.querySelector('.question-card input'));
  await page.button('Connections');
  await page.button('Connections');
  assert.equal(
    (await readReply()).questions[0].status,
    'pending',
    'Ordinary app navigation cancelled the run',
  );
  console.log('Real Claude is waiting; reloading the native page without answering.');
  await reload();
  await openHistoryChat(title);
  await send('Reply only: RELOAD RECOVERY PASSED. Do not ask another question or use any tools.');
  const finishDeadline = Date.now() + 180000;
  while (Date.now() < finishDeadline) {
    reply = await readReply();
    if (reply?.role === 'assistant' && reply.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/reload-native.png', Buffer.from(screenshot.data, 'base64'));
  assert.equal(reply?.status, 'complete', reply?.error ?? 'New response never completed');
  assert.match(
    reply.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join(''),
    /RELOAD RECOVERY PASSED/,
  );
  const after = children();
  assert(
    !before.some((pid) => after.includes(pid)),
    'The original waiting provider survived reload',
  );
  await writeFile(
    'artifacts/reload-native-result.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: 'claude',
        model: 'opus',
        originalRun,
        oldProcessExited: true,
        replacementStatus: reply.status,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(page.errors, []);
  console.log('NATIVE_RELOAD_RECOVERY_PASSED: owned process stopped, replacement reply completed.');
} finally {
  if (originalRun)
    await page
      .invoke('cancel_run', { runId: originalRun, waitForCompletion: true })
      .catch(() => {});
  page.close();
}
