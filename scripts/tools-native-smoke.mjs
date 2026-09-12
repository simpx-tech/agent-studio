// Opt-in: existing Windows CLI logins, temporary fixture folders, isolated native app only.
// Start Vite, then Tauri with native-tools.tauri.json and WebView CDP port 9437.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { nativePage } from './native-page.mjs';

const page = await nativePage(Number(process.env.AGENT_STUDIO_TOOLS_QA_PORT ?? 9437));
const identifier =
  process.env.AGENT_STUDIO_TOOLS_QA_IDENTIFIER ?? 'com.vinicius.agentstudio.tools-qa';
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert(identifier.startsWith('com.vinicius.agentstudio.') && identifier.endsWith('-qa'));
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.waitFor(() => !!document.querySelector('[aria-label="New conversation"]'));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace && workspace.conversations.length === 0,
    'Use an empty isolated tools QA workspace.',
  );
  const identity = await page.invoke('get_installation');
  for (const account of workspace.fleet.accounts) account.purpose ??= 'personal';
  for (const provider of ['claude', 'codex', 'gemini']) {
    if (!workspace.fleet.accounts.some((a) => a.provider === provider)) {
      const accountId = crypto.randomUUID();
      workspace.fleet.accounts.push({
        id: accountId,
        name: `${provider} tools QA`,
        provider,
        purpose: 'personal',
      });
      workspace.fleet.connections.push({
        id: crypto.randomUUID(),
        accountId,
        environmentId: identity.id,
        profile: 'existing',
      });
    }
  }
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(() => !!document.querySelector('[aria-label="New conversation"]'));
  await mkdir('artifacts/tools-smoke', { recursive: true });
  for (const [provider, model] of [
    ['claude', 'sonnet'],
    ['codex', 'gpt-5.6-sol'],
    ['gemini', 'gemini-3.8-flash'],
  ]) {
    const project = await mkdtemp(resolve(`artifacts/tools-smoke/${provider}-`));
    const challenge = crypto.randomUUID();
    await writeFile(join(project, 'challenge.txt'), challenge);
    await writeFile(
      join(project, 'verify.cjs'),
      `const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('answer.txt', 'utf8').trim(), fs.readFileSync('challenge.txt', 'utf8').trim());
fs.writeFileSync('command-proof.json', JSON.stringify({ verified: true, cwd: process.cwd(), pid: process.pid }));
console.log('TOOLS_COMMAND_OK');
`,
    );
    const accountIds = workspace.fleet.accounts
      .filter((a) => a.provider === provider)
      .map((a) => a.id);
    const connection = workspace.fleet.connections.find(
      (c) =>
        accountIds.includes(c.accountId) &&
        c.environmentId === identity.id &&
        c.profile === 'existing',
    );
    assert(connection, `Missing existing ${provider} connection`);
    if (provider === 'gemini') {
      const title = await page.invoke('generate_title', {
        conversationId: crypto.randomUUID(),
        provider,
        firstMessage: 'Testing file tools',
        connectionId: connection.id,
      });
      assert(title.title.length > 0);
      const appData = join(process.env.LOCALAPPDATA, identifier);
      await mkdir(join(appData, 'chat-runtime/.agents'), { recursive: true });
      await copyFile(
        join(appData, 'title-runtime/.agents/hooks.json'),
        join(appData, 'chat-runtime/.agents/hooks.json'),
      );
    }
    const location = { computerId: identity.computerId, environmentId: identity.id, path: project };
    const agent = {
      provider,
      model,
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    };
    const prompt =
      'Tools QA in this selected fixture directory: read challenge.txt, use a file editing tool to create answer.txt containing exactly that value, then execute node verify.cjs in this folder. Do not change verify.cjs or create command-proof.json yourself. Do not inspect anything outside this fixture directory or use external integrations. Reply with the challenge value and TOOLS_COMMAND_OK only after the command succeeds.';
    console.log(`Checking ${provider} through native IPC...`);
    // Start asynchronously so the host can poll without a long CDP evaluation timeout.
    await page.evaluate(
      ({ location, agent, prompt, connectionId }) => {
        window.toolsSmoke = { events: [], done: false };
        const internal = window.__TAURI_INTERNALS__;
        const id = internal.transformCallback((event) =>
          window.toolsSmoke.events.push(event.message),
        );
        internal
          .invoke('run_agent', {
            connectionId,
            request: {
              runId: crypto.randomUUID(),
              location,
              agent,
              messages: [
                { role: 'user', text: 'Can you read files here?' },
                {
                  role: 'assistant',
                  text: 'I cannot read files or run commands; tools are disabled.',
                },
                { role: 'user', text: prompt },
              ],
            },
            onEvent: `__CHANNEL__:${id}`,
          })
          .then((status) => {
            window.toolsSmoke.status = status;
          })
          .catch((error) => {
            window.toolsSmoke.error = String(error);
          })
          .finally(() => {
            internal.unregisterCallback(id);
            window.toolsSmoke.done = true;
          });
      },
      { location, agent, prompt, connectionId: connection.id },
    );
    const deadline = Date.now() + 300_000;
    while (!(await page.evaluate(() => window.toolsSmoke.done))) {
      assert(Date.now() < deadline, `${provider} run timed out`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const result = await page.evaluate(() => window.toolsSmoke);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 'complete');
    const text = result.events.filter((e) => e?.kind === 'text').at(-1)?.text ?? '';
    assert(
      text.includes(challenge) && text.includes('TOOLS_COMMAND_OK'),
      'Reply did not verify fixture',
    );
    assert.equal((await readFile(join(project, 'answer.txt'), 'utf8')).trim(), challenge);
    const proof = JSON.parse(await readFile(join(project, 'command-proof.json'), 'utf8'));
    assert.equal(proof.verified, true);
    assert.equal(proof.cwd.toLowerCase(), project.toLowerCase());
    if (provider === 'gemini') {
      const appData = join(process.env.LOCALAPPDATA, identifier);
      assert.equal(
        await access(join(appData, 'chat-runtime/.agents/hooks.json')).then(
          () => true,
          () => false,
        ),
        false,
      );
      await access(join(appData, 'title-runtime/.agents/hooks.json'));
    }
    const activities = result.events.filter((e) => e?.kind === 'activity').map((e) => e.text);
    if (provider !== 'gemini') {
      assert(
        activities.some((a) =>
          provider === 'codex' ? a === 'Running command' : /Using (Bash|PowerShell)/.test(a),
        ) || result.events.some((e) => e?.kind === 'tool' && e.tool?.commandRun === true),
        'Missing native command activity',
      );
    }
    report.providers[provider] = {
      read: true,
      write: true,
      command: true,
      continuedRestrictedHistory: true,
      activities,
    };
    // Render the verified result in this disposable QA workspace, with no real chat data.
    const now = new Date().toISOString();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: `${provider} tools QA`,
      titleStatus: 'fallback',
      location,
      settings: agent,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', text: prompt },
        { role: 'assistant', text },
      ].map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        blocks: [{ type: 'markdown', text: m.text }],
        status: 'complete',
        createdAt: now,
        ...(m.role === 'assistant' ? { settings: agent } : {}),
      })),
    });
    console.log(`${provider}: real file read, write, and command passed.`);
  }
  await writeFile('artifacts/tools-native-smoke.json', JSON.stringify(report, null, 2));
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(() => !!document.querySelector('#conversation-tab-history'));
  await page.click('#conversation-tab-history');
  await page.waitFor(() => document.querySelectorAll('.conversation-item').length === 3);
  await page.evaluate(() => [...document.querySelectorAll('.conversation-item')].at(-1).click());
  await page.waitFor(() =>
    document
      .querySelector('[aria-label="Agent"]')
      ?.getAttribute('title')
      ?.includes('without approval prompts'),
  );
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/tools-enabled-native.png', Buffer.from(screenshot.data, 'base64'));
  report.errors = page.errors;
  assert.deepEqual(page.errors, []);
  await writeFile('artifacts/tools-native-smoke.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
