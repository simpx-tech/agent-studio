// Opt-in real-provider proof in the dedicated file-changes QA identity only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const targets = [await (await fetch('http://127.0.0.1:9561/json/list')).json()]
  .flat()
  .filter((t) => t.type === 'page');
assert.equal(targets.length, 1, 'Expected exactly one page in the dedicated QA webview');
const page = await nativePage(9561, targets[0].url);
const report = [];
const providers = (process.env.QA_FILE_PROVIDERS ?? 'codex,claude').split(',');
async function reloadReady() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => (window.fileChangeQaMarker = marker), marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.fileChangeQaMarker !== marker &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    marker,
  );
}
async function select(title) {
  await page.click('#conversation-tab-history');
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((el) =>
        el.textContent.includes(title),
      ),
    title,
  );
  await page.evaluate((title) => {
    const row = [...document.querySelectorAll('.conversation-item')].find((el) =>
      el.textContent.includes(title),
    );
    row?.click();
  }, title);
  await page.waitFor(
    (title) =>
      document
        .querySelector('.conversation-item[aria-current="page"]')
        ?.textContent.includes(title),
    title,
  );
}
async function submit(chat, prompt) {
  const previous = (await page.invoke('load_workspace')).conversations
    .find((c) => c.id === chat.id)
    ?.messages.at(-1)?.id;
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
    const saved = (await page.invoke('load_workspace')).conversations.find((c) => c.id === chat.id);
    const reply = saved?.messages.at(-1);
    if (reply?.role === 'assistant' && reply.id !== previous && reply.status !== 'running') {
      assert.equal(reply.status, 'complete', reply.error);
      return reply;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native reply timed out');
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.file-changes-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  await mkdir('artifacts', { recursive: true });
  for (const provider of providers) {
    let workspace = await page.invoke('load_workspace');
    assert(
      workspace.conversations.every((c) => c.title.startsWith('File changes QA')),
      'Not a disposable QA workspace',
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
    assert(connection, `Missing ${provider} connection`);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
      `${provider} requires sign-in`,
    );
    let chat = workspace.conversations.find((c) => c.title === `File changes QA ${provider}`);
    if (!chat) {
      const folder = await mkdtemp(join(tmpdir(), `studio-file-changes-${provider}-`));
      await writeFile(join(folder, 'example.txt'), 'original\n');
      const now = new Date().toISOString();
      chat = {
        id: crypto.randomUUID(),
        title: `File changes QA ${provider}`,
        titleStatus: 'fallback',
        createdAt: now,
        updatedAt: now,
        settings: {
          provider,
          connectionId: connection.id,
          model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
          reasoning: 'low',
          instructions: '',
        },
        location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
        messages: [],
      };
      workspace.conversations.push(chat);
      await page.invoke('save_workspace', { workspace });
    }
    await reloadReady();
    await select(chat.title);
    const tool = provider === 'claude' ? 'Read and Edit tools' : 'read tool and apply_patch';
    for (const [round, before, after] of [
      [1, 'original', 'intermediate'],
      [2, 'intermediate', 'final'],
    ]) {
      workspace = await page.invoke('load_workspace');
      const saved = workspace.conversations.find((c) => c.id === chat.id);
      let reply = saved.messages.filter((m) => m.role === 'assistant')[round - 1];
      const reused = !!reply;
      if (!reply)
        reply = await submit(
          chat,
          `Use only ${tool} to read example.txt in this disposable working folder and replace its one line '${before}' with '${after}', preserving the newline. Do not edit any other file, use shell commands to write files, inspect other folders, use integrations, or delegate. Reply with 'Updated example.txt'.`,
        );
      await writeFile(
        `artifacts/file-changes-native-${provider}-round${round}.json`,
        JSON.stringify(reply, null, 2),
      );
      assert(reply.fileChanges?.edits.length, `${provider} did not record a confirmed file edit`);
      assert(
        reply.fileChanges.edits.some((edit) =>
          edit.files.some(
            (file) =>
              file.path.endsWith('example.txt') &&
              file.hunks?.some((h) => h.lines.includes('+' + after)),
          ),
        ),
        `${provider} did not retain the code diff`,
      );
      if (!reused || round === 2)
        assert.equal(await readFile(join(chat.location.path, 'example.txt'), 'utf8'), after + '\n');
    }
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = 'Preserve this draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelectorAll('.file-changes > summary').item(1).click();
    });
    await page.waitFor(() => document.querySelectorAll('.file-changes').item(1)?.open);
    await page.evaluate(() =>
      document
        .querySelectorAll('.file-changes')
        .item(1)
        .querySelector('.changed-file > summary')
        .click(),
    );
    const response = await page.evaluate(
      () =>
        [...document.querySelectorAll('.file-changes')].at(-1).querySelector('.diff-table')
          .textContent,
    );
    assert(response.includes('-intermediate') && response.includes('+final'));
    await page.evaluate(() =>
      document
        .querySelectorAll('.file-changes')
        .item(1)
        .querySelector('[data-mode="chat"]')
        .click(),
    );
    await page.evaluate(() =>
      document
        .querySelectorAll('.file-changes')
        .item(1)
        .querySelector('.changed-file > summary')
        .click(),
    );
    const all = await page.evaluate(
      () =>
        [...document.querySelectorAll('.file-changes')].at(-1).querySelector('.diff-table')
          .textContent,
    );
    assert(all.includes('-original') && all.includes('+final') && !all.includes('intermediate'));
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Preserve this draft',
    );
    await page.cdp('Page.bringToFront');
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      const scroll = document.querySelector('.chat-scroll');
      scroll.scrollTop = scroll.scrollHeight;
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const capture = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/file-changes-native-${provider}.png`,
      Buffer.from(capture.data, 'base64'),
    );
    await reloadReady();
    await select(chat.title);
    await page.waitFor(() => document.querySelectorAll('.file-changes').length === 2);
    report.push({
      provider,
      chatId: chat.id,
      rounds: 2,
      savedDiffs: true,
      cumulativeDiff: true,
      draftPreserved: true,
      reloadPassed: true,
    });
    console.log(`${provider}: two native edit rounds, cumulative diff, draft and reload passed`);
  }
  await writeFile('artifacts/file-changes-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
