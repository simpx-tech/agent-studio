// Opt-in real Windows CLI metadata and Claude hook execution, isolated app/CDP 19647.
// Codex uses an empty QA profile for read-only hooks/list; no credentials are copied.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/hooks';
await mkdir(output, { recursive: true });
const page = await nativePage(
  Number(process.env.STUDIO_HOOKS_CDP_PORT ?? 19647),
  process.env.STUDIO_HOOKS_URL ?? 'http://127.0.0.1:1430/',
);
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.hooks-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Hooks QA')));
  const identity = await page.invoke('get_installation');
  const folder = await mkdtemp(join(tmpdir(), 'studio-hooks-'));
  const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
  const connections = {};
  for (const provider of ['claude', 'codex']) {
    const accountId = crypto.randomUUID(),
      id = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `Hooks QA ${provider}`,
      provider,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id,
      accountId,
      environmentId: identity.id,
      profile: provider === 'codex' ? 'isolated' : 'existing',
    });
    connections[provider] = id;
  }
  const chat = {
    id: crypto.randomUUID(),
    title: `Hooks QA ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      provider: 'claude',
      model: 'sonnet',
      reasoning: 'low',
      instructions: '',
      connectionId: connections.claude,
    },
    location,
    messages: [],
  };
  workspace.conversations.push(chat);
  await page.invoke('save_workspace', { workspace });
  await mkdir(join(folder, '.claude'));
  await writeFile(
    join(folder, 'hook.cjs'),
    `const fs = require('node:fs'); let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const v = JSON.parse(input); fs.appendFileSync('hook-proof.log', v.hook_event_name + '\\n'); });`,
  );
  await writeFile(join(folder, 'proof.txt'), 'HOOKS_NATIVE_OK');
  const handler = { type: 'command', command: 'node hook.cjs', timeout: 10 };
  await writeFile(
    join(folder, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [handler] }],
        PreToolUse: [{ matcher: 'Read', hooks: [handler] }],
        PostToolUse: [{ matcher: 'Read', hooks: [handler] }],
        Stop: [{ hooks: [handler] }],
      },
    }),
  );
  const codexArgs = { provider: 'codex', model: '', connectionId: connections.codex, location };
  const empty = await page.invoke('read_context', codexArgs);
  assert(
    empty.profile.includes('com.vinicius.agentstudio.hooks-qa') &&
      empty.profile.includes(connections.codex),
  );
  await writeFile(
    join(empty.profile, 'hooks.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node hook.cjs' }] }] },
    }),
  );
  const codex = await page.invoke('read_context', codexArgs);
  const codexHooks = codex.entries.filter((e) => e.kind === 'hooks');
  assert.equal(codexHooks.length, 1);
  assert.equal(codexHooks[0].status, 'needsReview');
  assert(!JSON.stringify(codexHooks).includes('node hook.cjs'));
  const claude = await page.invoke('read_context', {
    provider: 'claude',
    model: 'sonnet',
    connectionId: connections.claude,
    location,
  });
  const claudeHooks = claude.entries.filter((e) => e.kind === 'hooks' && e.path.startsWith(folder));
  assert.equal(claudeHooks.length, 4);
  await assert.rejects(
    access(join(folder, 'hook-proof.log')),
    'Inspection must not execute the hook',
  );
  report.providers.codex = { catalog: codexHooks, inspectionDidNotExecuteHooks: true };
  report.providers.claude = { catalog: claudeHooks, inspectionDidNotExecuteHooks: true };
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log('Native hook inventories passed for Codex and Claude without running hooks.');
  assert.equal(
    (
      await page.invoke('detect_connection', {
        provider: 'claude',
        connectionId: connections.claude,
      })
    ).auth,
    'ready',
  );
  await page.evaluate(() => (window.hooksReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () => !window.hooksReload && document.querySelector('#conversation-tab-history'),
  );
  await page.click('#conversation-tab-history');
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((e) =>
        e.textContent.includes(title),
      ),
    chat.title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  await page.button('Model context');
  await page.waitFor(() =>
    [...document.querySelectorAll('.context-categories button')].some((e) =>
      e.textContent.startsWith('Hooks'),
    ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('.context-categories button')]
      .find((e) => e.textContent.startsWith('Hooks'))
      .click(),
  );
  await page.waitFor(() => document.querySelectorAll('.context-entry').length >= 4);
  let shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native-context.png`, Buffer.from(shot.data, 'base64'));
  await page.button('Close model context');
  await page.evaluate(() => {
    const e = document.querySelector('[aria-label="Message"]');
    e.value =
      'Read proof.txt using the Read tool once, then reply exactly HOOKS_NATIVE_OK. Do not use any other tools.';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  let message;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const saved = await page.invoke('load_workspace');
    message = saved.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
    if (message?.role === 'assistant' && message.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(message?.status, 'complete', message?.error);
  const hooks = message.blocks.flatMap((b) =>
    b.type === 'activity' && b.tool?.category === 'hook' ? [b.tool] : [],
  );
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert(
      hooks.some((h) => h.name === `${event} hook` && h.status === 'complete'),
      `Missing completed ${event}`,
    );
  }
  const proof = await readFile(join(folder, 'hook-proof.log'), 'utf8');
  report.providers.claude.execution = {
    status: message.status,
    hooks,
    proof: proof.trim().split('\n'),
  };
  await page.evaluate(() => document.querySelector('[aria-label="Work history"]').click());
  await page.evaluate(() =>
    document
      .querySelectorAll('.activity-group, .tool-card[data-category="hook"]')
      .forEach((e) => (e.open = true)),
  );
  shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native-history.png`, Buffer.from(shot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  report.errors = page.errors;
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log('Real Claude hook execution, saved activity, and native render passed.');
} finally {
  page.close();
}
