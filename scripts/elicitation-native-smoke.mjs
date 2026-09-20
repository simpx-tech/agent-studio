// Opt-in native WebView + installed Claude check. Uses only a disposable QA
// workspace and MCP server with synthetic data; existing CLI login stays local.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/elicitation-native';
await mkdir(output, { recursive: true });
const page = await nativePage(19671, 'http://127.0.0.1:1461/');
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.elicitation-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Elicitation QA')));
  const identity = await page.invoke('get_installation');
  const folder = await mkdtemp(join(tmpdir(), 'studio-elicitation-'));
  await mkdir(join(folder, '.claude'));
  await writeFile(
    join(folder, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        elicitation_fixture: {
          command: process.execPath,
          args: [resolve('scripts/elicitation-mcp-fixture.mjs')],
        },
      },
    }),
  );
  await writeFile(
    join(folder, '.claude/settings.local.json'),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  const accountId = crypto.randomUUID(),
    connectionId = crypto.randomUUID();
  workspace.fleet.accounts.push({
    id: accountId,
    name: 'Elicitation QA Claude',
    provider: 'claude',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: identity.id,
    profile: 'existing',
  });
  const chat = {
    id: crypto.randomUUID(),
    title: `Elicitation QA ${Date.now()}`,
    titleStatus: 'fallback',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      provider: 'claude',
      model: 'sonnet',
      reasoning: 'low',
      instructions: '',
      connectionId,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  };
  workspace.conversations.push(chat);
  await page.invoke('save_workspace', { workspace });
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'claude', connectionId })).auth,
    'ready',
  );
  await page.evaluate(() => (window.elicitationReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.elicitationReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false &&
      document.querySelector('#conversation-tab-history'),
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
  await page.waitFor(() => document.querySelector('textarea[aria-label="Message"]'));
  await page.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="Message"]');
    input.value =
      "Call elicitation_fixture's prompt tool with mode form exactly once. Discover that tool if necessary. Wait for my synthetic answer, then reply ELICITATION_NATIVE_PASSED and its reported action. Do not use any other tool, file, shell, network or subagent. Do not answer on my behalf.";
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const deadline = Date.now() + 150000;
  while (
    !(await page.evaluate(() => !!document.querySelector('.elicitation input[type="text"]')))
  ) {
    assert(Date.now() < deadline, 'Installed Claude did not present the form');
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.evaluate(() => {
    const input = document.querySelector('.elicitation input[type="text"]');
    input.value = 'Ada';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const draft = document.querySelector('textarea[aria-label="Message"]');
    draft.value = 'Keep this draft';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/form.png`, Buffer.from(screenshot.data, 'base64'));
  await page.button('Send answers');
  while (
    !(await page.evaluate(
      () =>
        document.body.innerText.includes('ELICITATION_NATIVE_PASSED') &&
        !document.querySelector('[aria-label="Stop response"]'),
    ))
  ) {
    assert(Date.now() < deadline, 'Claude did not continue after receiving input');
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    await page.evaluate(() => document.querySelector('textarea[aria-label="Message"]').value),
    'Keep this draft',
  );
  const saved = await page.invoke('load_workspace');
  const response = saved.conversations
    .find((c) => c.id === chat.id)
    .messages.find((m) => m.role === 'assistant');
  assert.equal(response.elicitations.length, 1);
  assert.equal(response.elicitations[0].status, 'accepted');
  assert(!JSON.stringify(response.elicitations).includes('Ada'));
  assert.deepEqual(page.errors, []);
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: 'claude',
        formAccepted: true,
        continued: true,
        draftPreserved: true,
        onlyReceiptSaved: true,
      },
      null,
      2,
    ),
  );
  console.log('Native Claude MCP form accepted; reply continued, draft preserved, receipt saved.');
} finally {
  page.close();
}
