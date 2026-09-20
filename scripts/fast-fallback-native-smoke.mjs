// Opt-in real-provider check in the isolated native-fast-fallback app only.
// Requests one tiny Fast-mode reply; actual fast service depends on account eligibility.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/claude-fast-fallback';
await mkdir(output, { recursive: true });
const page = await nativePage(19678, 'http://127.0.0.1:1478/');
const fill = (selector, value) =>
  page.evaluate(
    (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) throw Error(`Missing ${selector}`);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
async function choose(label, name) {
  await page.click(`[role="combobox"][aria-label="${label}"]`);
  await page.waitFor(() => !!document.querySelector('[role="option"]'));
  await page.evaluate((name) => {
    const el = [...document.querySelectorAll('[role="option"]')].find(
      (e) => e.getAttribute('aria-label') === name,
    );
    if (!el) throw Error(`Missing choice ${name}`);
    el.click();
  }, name);
}
function processSettings() {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('agent-studio.exe','claude.exe') } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ],
    { windowsHide: true },
  ).toString();
  const processes = [JSON.parse(raw)].flat();
  const apps = new Set(
    processes
      .filter(
        (p) => p.Name === 'agent-studio.exe' && p.ExecutablePath?.includes('cargo-fast-fallback'),
      )
      .map((p) => p.ProcessId),
  );
  return processes
    .filter(
      (p) =>
        p.Name === 'claude.exe' &&
        apps.has(p.ParentProcessId) &&
        p.CommandLine?.includes('--replay-user-messages'),
    )
    .map((p) => ({
      pid: p.ProcessId,
      fastOn: /fastMode[^a-z]+true/.test(p.CommandLine),
      fastOff: /fastMode[^a-z]+false/.test(p.CommandLine),
      fallback: /--fallback-model\s+"?haiku/.test(p.CommandLine),
      resumed: p.CommandLine.includes('--resume'),
    }));
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.fast-fallback-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Fast Fallback QA')),
    'Not a disposable workspace',
  );
  const accountIds = new Set(
    workspace.fleet.accounts.filter((a) => a.provider === 'claude').map((a) => a.id),
  );
  const connection = workspace.fleet.connections.find(
    (c) =>
      accountIds.has(c.accountId) && c.environmentId === identity.id && c.profile === 'existing',
  );
  assert(connection, 'Missing existing local Claude connection');
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'claude', connectionId: connection.id }))
      .auth,
    'ready',
  );
  const id = crypto.randomUUID(),
    now = new Date().toISOString(),
    title = `Fast Fallback QA ${id.slice(0, 8)}`;
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
    location: {
      computerId: identity.computerId,
      environmentId: identity.id,
      path: await mkdtemp(join(tmpdir(), 'studio-fast-fallback-')),
    },
    messages: [],
  });
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.qaReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.qaReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('History'))
      ?.click(),
  );
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
  const report = { checkedAt: now, replies: [] };
  const oldPids = new Set(processSettings().map((p) => p.pid));
  for (const [index, fast] of ['off', 'on', 'off', 'off'].entries()) {
    await page.button('Chat instructions');
    await page.waitFor(() => !!document.querySelector('[aria-label="Fast mode"]'));
    await choose('Fast mode', fast === 'on' ? 'On' : 'Off');
    await fill('input[aria-describedby="fallback-model-hint"]', 'haiku');
    await page.button('Save instructions');
    const previous = (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === id)
      .messages.at(-1)?.id;
    await fill(
      '[aria-label="Message"]',
      `What is ${index + 1} + ${index + 1}? Answer with one digit. Do not use tools.`,
    );
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    let message;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const m = (await page.invoke('load_workspace')).conversations
        .find((c) => c.id === id)
        .messages.at(-1);
      if (m?.id !== previous && m?.role === 'assistant' && m.status !== 'running') {
        message = m;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(message, 'Reply timed out');
    assert.equal(message.status, 'complete', message.error);
    assert.equal(
      message.blocks
        .filter((b) => b.type === 'markdown')
        .map((b) => b.text)
        .join('')
        .trim(),
      String((index + 1) * 2),
    );
    assert.equal(message.settings.fastMode, fast === 'on');
    assert.equal(message.settings.fallbackModel, 'haiku');
    const owned = processSettings().filter((p) => !oldPids.has(p.pid));
    assert.equal(owned.length, 1);
    const process = owned[0];
    assert.equal(process.fastOn, fast === 'on');
    assert.equal(process.fastOff, fast === 'off');
    assert(process.fallback);
    if (index > 0) {
      assert(process.resumed);
      assert.equal(
        process.pid === report.replies.at(-1).pid,
        index === 3,
        'Only changed launch settings replace the parked process',
      );
    }
    report.replies.push({
      ...process,
      fast,
      reportedModel: message.usage?.model,
      status: message.status,
    });
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.replies.at(-1)));
  }
  await page.button('Chat instructions');
  await page.evaluate(() =>
    document.querySelector('[aria-label="Fast mode"]').scrollIntoView({ block: 'center' }),
  );
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('FAST_FALLBACK_NATIVE_OK');
} finally {
  page.close();
}
