// Opt-in real-provider UI proof, isolated scripts/native-compaction.tauri.json on CDP 9597.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/compaction';
await mkdir(output, { recursive: true });
const page = await nativePage(9597);
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
const type = (value) =>
  page.evaluate((value) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
async function select(chat) {
  await page.evaluate((title) => {
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('History'))
      ?.click();
  }, chat.title);
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
}
async function reply(chat, previousId) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const w = await page.invoke('load_workspace');
    const m = w.conversations.find((c) => c.id === chat.id).messages.at(-1);
    if (m?.role === 'assistant' && m.id !== previousId && m.status !== 'running') {
      assert.equal(m.status, 'complete', m.error);
      return m;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Reply timed out');
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.compaction-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation'),
    workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Compaction QA')),
    'Not a disposable workspace',
  );
  const report = { checkedAt: new Date().toISOString(), chats: [] };
  for (const provider of ['claude', 'codex']) {
    if (process.argv.includes('--resume')) {
      const existing = workspace.conversations.findLast((c) => c.settings.provider === provider);
      assert(existing, 'No disposable chat to resume');
      report.chats.push({ id: existing.id, title: existing.title, provider });
      continue;
    }
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      folder = await mkdtemp(join(tmpdir(), `studio-compaction-${provider}-`));
    const chat = {
      id,
      title: `Compaction QA ${provider} ${id.slice(0, 8)}`,
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
    };
    workspace.conversations.push(chat);
    report.chats.push({ id, title: chat.title, provider });
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.compactionReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.compactionReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of report.chats) {
    await select(chat);
    const saved = (await page.invoke('load_workspace')).conversations.find(
      (c) => c.id === chat.id,
    ).messages;
    let first = saved.find((m) => m.role === 'assistant');
    if (!first) {
      await type('Remember this test fact: the violet lighthouse code is 7319. Reply only READY.');
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.button('Send message');
      first = await reply(chat);
    }
    assert.equal(first.status, 'complete', first.error);
    let compacted = saved.find((m) => m.compact && m.status === 'complete');
    if (!compacted) {
      await type('Preserved composer draft');
      await page.evaluate(() => document.querySelector('.usage-chip')?.click());
      await page.waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent.trim() === 'Compact context' && !b.disabled,
        ),
      );
      if (chat.provider === 'claude') {
        await page.button('Claude auto-compaction window');
        await page.waitFor(() => document.querySelector('[role="option"]'));
        await page.evaluate(() =>
          [...document.querySelectorAll('[role="option"]')]
            .find((e) => /100[.,]000 tokens/.test(e.textContent))
            .click(),
        );
      }
      await page.button('Compact context');
      compacted = await reply(chat, first.id);
      assert(compacted.compact);
      assert(compacted.compactions?.some((c) => c.status === 'complete' && c.trigger === 'manual'));
      assert.equal(
        await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
        'Preserved composer draft',
      );
      const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${output}/native-${chat.provider}.png`, Buffer.from(shot.data, 'base64'));
      await page.button('Close usage details');
    }
    let next = saved.find(
      (m) => m.role === 'assistant' && m.id !== first.id && !m.compact && m.status === 'complete',
    );
    if (!next) {
      await type('What is the lighthouse code? Reply with the code only.');
      await page.button('Send message');
      next = await reply(chat, compacted.id);
    }
    assert(text(next).includes('7319'), text(next));
    chat.compaction = compacted.compactions;
    chat.recall = text(next);
    await page.cdp('Page.reload');
    await page.waitFor(
      () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    await select(chat);
    await page.waitFor(() => !!document.querySelector('[aria-label="Context compaction"]'));
    const historyShot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `${output}/native-${chat.provider}-history.png`,
      Buffer.from(historyShot.data, 'base64'),
    );
  }
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  page.close();
}
