// Opt-in real-provider check. Use only the isolated native-claude-settings config.
// Starts a disposable chat; changes settings through the real UI without reloading.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/claude-settings';
await mkdir(output, { recursive: true });
const page = await nativePage(19673, 'http://127.0.0.1:1469/');
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
const fill = (selector, value) =>
  page.evaluate(
    (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) throw Error(`Missing input ${selector}`);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
function pids() {
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
  const all = [JSON.parse(raw)].flat();
  const apps = new Set(
    all
      .filter((p) => p.Name === 'agent-studio.exe' && p.ExecutablePath?.includes('claude-settings'))
      .map((p) => p.ProcessId),
  );
  return all
    .filter(
      (p) =>
        p.Name === 'claude.exe' &&
        apps.has(p.ParentProcessId) &&
        /--replay-user-messages/.test(p.CommandLine ?? ''),
    )
    .map((p) => p.ProcessId);
}
async function choose(label, prefix) {
  await page.click(`[role="combobox"][aria-label="${label}"]`);
  await page.waitFor(() => !!document.querySelector('[role="option"]'));
  await page.evaluate((prefix) => {
    const el = [...document.querySelectorAll('[role="option"]')].find((e) =>
      (e.getAttribute('aria-label') ?? '').startsWith(prefix),
    );
    if (!el) throw Error(`Option not available: ${prefix}`);
    el.click();
  }, prefix);
}
async function budget(value) {
  await page.waitFor(
    () => document.querySelector('[aria-label="Chat instructions"]')?.disabled === false,
  );
  await page.button('Chat instructions');
  await page.waitFor(
    () => !!document.querySelector('input[aria-describedby="thinking-budget-hint"]'),
  );
  await fill('input[aria-describedby="thinking-budget-hint"]', value);
  await page.button('Save instructions');
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.claude-settings-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Claude Settings QA')),
    'Not a disposable workspace',
  );
  const account = workspace.fleet.accounts.find((a) => a.provider === 'claude');
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
  );
  assert(connection, 'Missing local Claude connection');
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'claude', connectionId: connection.id }))
      .auth,
    'ready',
  );
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const title = `Claude Settings QA ${id.slice(0, 8)}`;
  workspace.conversations.push({
    id,
    title,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider: 'claude',
      model: 'sonnet',
      reasoning: '',
      instructions: '',
      connectionId: connection.id,
    },
    location: {
      computerId: identity.computerId,
      environmentId: identity.id,
      path: await mkdtemp(join(tmpdir(), 'studio-claude-settings-')),
    },
    messages: [],
  });
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.settingsReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.settingsReload &&
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
  const before = pids();
  const marker = `SETTINGS_${id.slice(0, 8)}`;
  let pid;
  for (const [index, step] of [
    { model: 'sonnet', budget: '1024' },
    { model: 'opus', budget: '4096', choose: 'Opus' },
    { model: 'opus', budget: '0' },
    { model: '', budget: '', choose: 'CLI default' },
  ].entries()) {
    if (step.choose) {
      await choose('Model', step.choose);
      // Keep effort identical; it is deliberately still a launch-time setting.
      const disabled = await page.evaluate(
        () => document.querySelector('[aria-label="Reasoning"]')?.disabled,
      );
      if (!disabled) await choose('Reasoning', 'Default');
    }
    await budget(step.budget);
    const previous = (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === id)
      .messages.at(-1)?.id;
    await fill(
      '[aria-label="Message"]',
      index === 0
        ? `Remember this marker: ${marker}. Reply only READY. Do not use tools.`
        : 'Reply only with the marker from my first message. Do not use tools.',
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
    assert.equal(text(message).trim(), index === 0 ? 'READY' : marker);
    assert.equal(message.settings.model, step.model);
    if (step.model)
      assert(message.usage?.model?.includes(step.model), 'Provider reports the selected model');
    else if (process.env.STUDIO_CLAUDE_EXPECT_DEFAULT)
      assert.equal(message.usage?.model, process.env.STUDIO_CLAUDE_EXPECT_DEFAULT);
    assert.equal(message.settings.reasoning, '');
    assert.equal(
      message.settings.maxThinkingTokens,
      step.budget === '' ? undefined : Number(step.budget),
    );
    const current = pids().filter((p) => !before.includes(p));
    assert.equal(current.length, 1, 'One owned Claude chat process');
    if (pid === undefined) pid = current[0];
    assert.equal(current[0], pid, 'Settings changes must keep the process');
    report.replies.push({
      model: message.settings.model,
      reportedModel: message.usage?.model,
      maxThinkingTokens: message.settings.maxThinkingTokens ?? null,
      pid,
      status: message.status,
    });
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.replies.at(-1)));
  }
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('CLAUDE_SETTINGS_NATIVE_OK');
} finally {
  page.close();
}
