// Run `first`, restart only native-standalone.tauri.json, then run `second`.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { nativePage } from './native-page.mjs';

const phase = process.argv[2] ?? 'first';
const identifier = 'com.vinicius.agentstudio.standalone-folders-20260913-qa';
const data = join(process.env.LOCALAPPDATA, identifier);
const output = 'artifacts/standalone/native.json';
const page = await nativePage(9541);
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const usedShell = (message) =>
  message.blocks.some(
    (b) =>
      b.type === 'activity' &&
      b.tool?.status === 'complete' &&
      (b.tool.commandRun === true || b.tool.name === 'PowerShell'),
  );
async function submit(chat, prompt) {
  const before = await page.invoke('load_workspace');
  const previousMessage = before.conversations.find((c) => c.id === chat.id)?.messages.at(-1)?.id;
  await page.invoke('plugin:event|emit', { event: 'studio-notification-open', payload: chat.id });
  await page.waitFor(
    (id) =>
      document.querySelector(`.conversation-item[aria-current="page"]`)?.textContent.includes(id),
    chat.title,
  );
  await page.evaluate((prompt) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const workspace = await page.invoke('load_workspace');
    const saved = workspace.conversations.find((c) => c.id === chat.id);
    const message = saved?.messages.at(-1);
    if (
      message?.role === 'assistant' &&
      message.id !== previousMessage &&
      message.status !== 'running'
    ) {
      assert.equal(message.status, 'complete', message.error);
      assert.equal(saved.location.path, '');
      assert.equal(saved.settings.connectionId, chat.connectionId);
      assert(usedShell(message), 'Expected a completed native shell tool');
      return text(message).trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Standalone reply timed out');
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.waitFor(() => !!document.querySelector('#conversation-tab-history'));
  let report;
  if (phase === 'first') {
    const installation = await page.invoke('get_installation');
    const workspace = await page.invoke('load_workspace');
    if (existsSync(output)) {
      report = await json(output);
      assert.deepEqual(
        workspace.conversations.map((c) => c.id).sort(),
        report.chats.map((c) => c.id).sort(),
      );
    } else {
      assert.equal(workspace.conversations.length, 0, 'Use a new disposable QA identity');
      report = { checkedAt: new Date().toISOString(), chats: [] };
      for (const [provider, legacy] of [
        ['codex', false],
        ['codex', false],
        ['claude', false],
        ['codex', true],
      ]) {
        const accounts = workspace.fleet.accounts
          .filter((a) => a.provider === provider)
          .map((a) => a.id);
        const connection = workspace.fleet.connections.find(
          (c) =>
            accounts.includes(c.accountId) &&
            c.environmentId === installation.id &&
            c.profile === 'existing',
        );
        assert(connection, `Missing existing Windows ${provider} connection`);
        assert.equal(
          (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
          'ready',
        );
        const id = crypto.randomUUID(),
          now = new Date().toISOString();
        const chat = {
          id,
          provider,
          legacy,
          title: `Standalone QA ${id.slice(0, 8)}`,
          connectionId: connection.id,
          value: crypto.randomUUID(),
        };
        chat.folder = join(data, legacy ? 'chat-runtime' : 'standalone', ...(legacy ? [] : [id]));
        const settings = {
          provider,
          model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
          reasoning: 'low',
          instructions: '',
          connectionId: connection.id,
        };
        workspace.conversations.push({
          id,
          title: chat.title,
          titleStatus: 'fallback',
          createdAt: now,
          updatedAt: now,
          settings,
          location: {
            computerId: installation.computerId,
            environmentId: installation.id,
            path: '',
          },
          messages: legacy
            ? [
                {
                  id: crypto.randomUUID(),
                  role: 'user',
                  blocks: [{ type: 'markdown', text: 'Earlier conversation.' }],
                  status: 'complete',
                  createdAt: now,
                },
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  provider,
                  modelName: settings.model,
                  status: 'complete',
                  createdAt: now,
                  blocks: [{ type: 'markdown', text: 'Ready.' }],
                },
              ]
            : [],
        });
        if (legacy) {
          await mkdir(chat.folder, { recursive: true });
          await writeFile(join(chat.folder, 'legacy-fixture.txt'), chat.value);
        }
        report.chats.push(chat);
      }
      await page.invoke('save_workspace', { workspace });
      await page.evaluate(() => (window.standaloneReload = true));
      await page.cdp('Page.reload');
      await page.waitFor(
        () => !window.standaloneReload && !!document.querySelector('#conversation-tab-history'),
      );
      await writeFile(output, JSON.stringify(report, null, 2));
    }
    for (const chat of report.chats) {
      const prompt = chat.legacy
        ? 'Use a shell tool to read legacy-fixture.txt in your current working directory. Reply with its exact contents. Do not create or change files or delegate.'
        : `Use one shell tool in your current working directory. First verify chat-file.txt does not exist (fail if it already exists); then write exactly ${chat.value} to the relative file chat-file.txt without a trailing newline. Do not change directories, use absolute paths, or delegate. Reply exactly READY.`;
      const saved = (await page.invoke('load_workspace')).conversations.find(
        (c) => c.id === chat.id,
      );
      if (saved.messages.length > (chat.legacy ? 2 : 0)) {
        const message = saved.messages.at(-1);
        assert.equal(message.status, 'complete');
        assert(usedShell(message));
        chat.first = text(message).trim();
      } else {
        chat.first = await submit(chat, prompt);
      }
      assert.equal(chat.first, chat.legacy ? chat.value : 'READY');
      if (!chat.legacy)
        assert.equal(await readFile(join(chat.folder, 'chat-file.txt'), 'utf8'), chat.value);
      const binding = await json(join(data, 'standalone-bindings', `${chat.id}.json`));
      assert.equal(binding.directory, chat.legacy ? 'legacy' : 'dedicated');
      chat.sessionId = (await json(join(data, 'native-sessions', `${chat.id}.json`))).id;
      const context = await page.invoke('read_context', {
        provider: chat.provider,
        model: chat.provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        connectionId: chat.connectionId,
        location: null,
        conversationId: chat.id,
      });
      assert.equal(normalize(context.folder).toLowerCase(), normalize(chat.folder).toLowerCase());
      chat.contextMatches = true;
      console.log(
        `${chat.provider} ${chat.legacy ? 'legacy' : 'dedicated'}: file and context verified`,
      );
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  } else {
    assert.equal(phase, 'second');
    report = await json(output);
    for (const chat of report.chats) {
      chat.second = await submit(
        chat,
        `Use a shell tool to read ${chat.legacy ? 'legacy-fixture.txt' : 'chat-file.txt'} from the current working directory. Reply with its exact contents. Do not change directories or files or delegate.`,
      );
      assert.equal(chat.second, chat.value);
      assert.equal(
        (await json(join(data, 'native-sessions', `${chat.id}.json`))).id,
        chat.sessionId,
      );
      chat.sameSessionAfterRestart = true;
      console.log(`${chat.provider}: saved folder and native session retained after app restart`);
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  }
  assert.deepEqual(page.errors, []);
  report.rendererErrors = page.errors;
  await writeFile(output, JSON.stringify(report, null, 2));
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/standalone/${phase}.png`, Buffer.from(screenshot.data, 'base64'));
} finally {
  page.close();
}
