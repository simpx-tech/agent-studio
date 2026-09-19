// Opt-in real-provider UI proof, isolated scripts/native-steering.tauri.json on CDP 9587.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/steering';
await mkdir(output, { recursive: true });
const page = await nativePage(9587);
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
async function reply(chat) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const w = await page.invoke('load_workspace');
    const m = w.conversations.find((c) => c.id === chat.id).messages.at(-1);
    if (m?.role === 'assistant' && m.status !== 'running') {
      assert.equal(m.status, 'complete', m.error);
      return m;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Reply timed out');
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.steering-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation'),
    workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Steering QA')),
    'Not a disposable workspace',
  );
  const report = { checkedAt: new Date().toISOString(), chats: [] };
  for (const provider of ['claude', 'codex']) {
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
      folder = await mkdtemp(join(tmpdir(), `studio-steering-${provider}-`));
    const chat = {
      id,
      title: `Steering QA ${provider} ${id.slice(0, 8)}`,
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
  await page.evaluate(() => (window.steeringReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.steeringReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of report.chats) {
    await select(chat);
    await type(
      'Use the shell tool to wait 12 seconds, then reply ORIGINAL. Do not put the wait in the background.',
    );
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    // Wait for actual provider activity, not merely the app-owned running placeholder.
    await page.waitFor(
      () =>
        !!document
          .querySelector('.message .activity-group, .message .tool-activity, .message .prose')
          ?.textContent?.trim(),
    );
    await new Promise((r) => setTimeout(r, 2000));
    const marker = `STEERED_${crypto.randomUUID().slice(0, 8)}`;
    await type(`Change the final reply to exactly ${marker} instead of ORIGINAL.`);
    await page.button('Steer now');
    await page.waitFor(() => !!document.querySelector('[aria-label="Steering messages"]'));
    const first = await reply(chat);
    assert(text(first).includes(marker), text(first));
    assert.equal(first.steering?.length, 1);
    const w = await page.invoke('load_workspace');
    assert.equal(
      w.conversations.find((c) => c.id === chat.id).messages.length,
      2,
      'Steering must not start another app reply',
    );
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/native-${chat.provider}.png`, Buffer.from(shot.data, 'base64'));
    chat.steered = { text: text(first), receipts: first.steering.length, runId: first.runId };
    await type('Repeat the exact marker I just asked for. Do not use tools.');
    await page.button('Send message');
    const second = await reply(chat);
    assert(text(second).includes(marker), text(second));
    chat.followup = { text: text(second), status: second.status };
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `${chat.provider}: steering acknowledged, corrected reply, and native follow-up passed`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
