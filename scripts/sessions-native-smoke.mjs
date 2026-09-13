// Run against the isolated native-sessions.tauri.json app, never the user's app.
// First phase reads disposable facts through real tools. Restart the QA app,
// then run `second` to prove recall comes from the CLI-owned transcript on disk.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const phase = process.argv[2] ?? 'first';
const output = 'artifacts/sessions';
await mkdir(output, { recursive: true });
const page = await nativePage(9513);
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
async function select(chat) {
  for (const tab of ['History', 'Active']) {
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
async function waitReply(chat, expected = 'complete') {
  const start = Date.now();
  while (Date.now() - start < 240000) {
    const w = await page.invoke('load_workspace');
    const m = w.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
    if (m?.role === 'assistant' && m.status !== 'running') {
      assert.equal(m.status, expected, m.error);
      return {
        text: text(m),
        error: m.error,
        elapsedMs: Date.now() - start,
        model: m.usage?.model ?? m.modelName,
        usage: m.usage,
        blocks: m.blocks,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native reply timed out');
}
async function waitQuestion(chat) {
  const start = Date.now();
  while (Date.now() - start < 180000) {
    const w = await page.invoke('load_workspace');
    const m = w.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
    if (m?.questions?.some((q) => q.status === 'pending')) return;
    if (m?.role === 'assistant' && m.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('No native question');
}
async function submit(chat, prompt, expected = 'complete') {
  await select(chat);
  await page.evaluate((prompt) => {
    const el = document.querySelector('[aria-label="Message"]');
    el.value = prompt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  return waitReply(chat, expected);
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.sessions-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  let report;
  if (phase === 'first') {
    const identity = await page.invoke('get_installation');
    const workspace = await page.invoke('load_workspace');
    assert(
      workspace.conversations.every((c) => c.title.startsWith('Sessions QA')),
      'Not a disposable workspace',
    );
    report = { checkedAt: new Date().toISOString(), chats: [] };
    for (const provider of ['claude', 'codex']) {
      const account = workspace.fleet.accounts.find((a) => a.provider === provider);
      const connection = workspace.fleet.connections.find(
        (c) =>
          c.accountId === account?.id &&
          c.environmentId === identity.id &&
          c.profile === 'existing',
      );
      assert(connection, `Missing ${provider} connection`);
      assert.equal(
        (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
        'ready',
      );
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const folder = await mkdtemp(join(tmpdir(), `studio-session-${provider}-`));
      const facts = { code: crypto.randomUUID(), threshold: 37, equality: 'inclusive' };
      await writeFile(join(folder, 'continuity-fixture.txt'), JSON.stringify(facts));
      const title = `Sessions QA ${provider} ${id.slice(0, 8)}`;
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
      report.chats.push({ id, provider, title, folder, facts });
    }
    await page.invoke('save_workspace', { workspace });
    await page.evaluate(() => (window.sessionsReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.sessionsReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    for (const chat of report.chats) {
      chat.first = await submit(
        chat,
        'Read continuity-fixture.txt with a file or shell tool. Remember its three facts for a later question. Do not write files, use other tools, or delegate. Reply exactly READY; do not include any fixture fact in your final answer.',
      );
      assert.equal(chat.first.text.trim(), 'READY');
      assert(!chat.first.text.includes(chat.facts.code));
      await unlink(join(chat.folder, 'continuity-fixture.txt'));
      console.log(`${chat.provider}: first turn complete; fixture removed`);
      await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    }
  } else if (phase === 'second') {
    report = JSON.parse(await readFile(`${output}/native-report.json`, 'utf8'));
    for (const chat of report.chats) {
      chat.second = await submit(
        chat,
        'Without using any tools, return the exact three facts from the file you read earlier as JSON with code, threshold, and equality. The file has been removed. Use only your existing conversation context.',
      );
      assert(
        chat.second.text.includes(chat.facts.code),
        `${chat.provider} lost tool-only context: ${chat.second.text}`,
      );
      assert(chat.second.text.includes('37') && chat.second.text.includes('inclusive'));
      console.log(`${chat.provider}: exact tool-only facts recalled after app restart`);
      await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    }
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/native-recall.png`, Buffer.from(shot.data, 'base64'));
  } else if (phase === 'defaults') {
    report = JSON.parse(await readFile(`${output}/native-report.json`, 'utf8'));
    const workspace = await page.invoke('load_workspace');
    for (const chat of report.chats) {
      const c = workspace.conversations.find((c) => c.id === chat.id);
      c.settings.model = '';
      c.settings.reasoning = '';
      c.settings.instructions = 'Append DEFAULT SETTINGS CONFIRMED to your next final answer.';
    }
    await page.invoke('save_workspace', { workspace });
    await page.evaluate(() => (window.sessionsReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.sessionsReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    for (const chat of report.chats) {
      chat.defaults = await submit(
        chat,
        'Do not use tools. Reply with READY and follow the current conversation instructions.',
      );
      assert(chat.defaults.text.includes('DEFAULT SETTINGS CONFIRMED'));
      console.log(
        `${chat.provider}: current defaults and instruction update applied; reported ${chat.defaults.model}`,
      );
      await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    }
  } else if (phase === 'missing') {
    report = JSON.parse(await readFile(`${output}/native-report.json`, 'utf8'));
    for (const chat of report.chats) {
      const binding = join(
        process.env.LOCALAPPDATA,
        'com.vinicius.agentstudio.sessions-qa',
        'native-sessions',
        chat.id + '.json',
      );
      const saved = await readFile(binding, 'utf8');
      const missing = JSON.stringify({ ...JSON.parse(saved), id: crypto.randomUUID() });
      try {
        await writeFile(binding, missing);
        chat.missing = await submit(chat, 'Do not use tools. Reply with RECOVERED.', 'error');
        assert(chat.missing.error?.includes('resume'), chat.missing.error);
        assert.equal(
          await readFile(binding, 'utf8'),
          missing,
          'Missing session must not silently bind a fresh thread',
        );
      } finally {
        await writeFile(binding, saved);
      }
      await page.button('Retry');
      chat.recovered = await waitReply(chat);
      assert(chat.recovered.text.includes('RECOVERED'));
      console.log(
        `${chat.provider}: missing session failed explicitly; restored binding resumed successfully`,
      );
      await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    }
  } else if (phase === 'cancel') {
    report = JSON.parse(await readFile(`${output}/native-report.json`, 'utf8'));
    for (const chat of report.chats) {
      const code = crypto.randomUUID();
      const filename = 'interruption-' + crypto.randomUUID() + '.txt';
      await writeFile(join(chat.folder, filename), code);
      const tool =
        chat.provider === 'claude' ? 'mcp__agent_studio__studio_ask_user' : 'studio_ask_user';
      const pending = submit(
        chat,
        `Read ${filename} once with a file or shell tool and remember its exact contents. Then use ${tool} to ask "Ready to continue?" with Continue and Wait choices. Do not disclose the file contents in progress or in the question. Wait for my answer, then reply only with those exact contents. Do not write files or delegate.`,
        'cancelled',
      );
      // Attach rejection handling immediately while waiting for the question.
      const stopped = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await waitQuestion(chat);
      await page.waitFor(() => !!document.querySelector('.question-card input'));
      await page.button('Stop response');
      const result = await stopped;
      if (result.error) throw result.error;
      await unlink(join(chat.folder, filename));
      await page.waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent.trim() === 'Retry' && !b.disabled,
        ),
      );
      await page.button('Retry');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await waitQuestion(chat);
      if (await page.evaluate(() => !!document.querySelector('.question-card input'))) {
        await page.click('.question-card input[type="radio"]');
        await page.button('Send answers');
      }
      chat.retry = await waitReply(chat);
      assert(
        chat.retry.text.includes(code),
        `${chat.provider} lost interrupted tool context: ${chat.retry.text}`,
      );
      console.log(
        `${chat.provider}: resumed question tool and Retry last preserved interrupted tool facts`,
      );
      await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    }
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
