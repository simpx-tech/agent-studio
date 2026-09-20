// Opt-in real-provider proof, only in native-structured-output.tauri.json's QA identity.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/structured-output';
await mkdir(output, { recursive: true });
const page = await nativePage(19668, 'http://127.0.0.1:1457/');
const schema = (key) =>
  JSON.stringify({
    type: 'object',
    properties: { [key]: { type: 'string' } },
    required: [key],
    additionalProperties: false,
  });
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
const fill = (selector, value) =>
  page.evaluate(
    (selector, value) => {
      const e = document.querySelector(selector);
      assertInput(e);
      function assertInput(e) {
        if (!e) throw Error('Input unavailable');
      }
      e.value = value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
async function select(chat) {
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
    chat.title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  await page.waitFor(() => !!document.querySelector('.conversation-item.current'));
}
async function reply(chat, prompt) {
  const before = (await page.invoke('load_workspace')).conversations
    .find((c) => c.id === chat.id)
    .messages.at(-1)?.id;
  await fill('[aria-label="Message"]', prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const m = (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      .messages.at(-1);
    if (m?.role === 'assistant' && m.id !== before && m.status !== 'running') {
      assert.equal(m.status, 'complete', m.error);
      return m;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Structured output reply timed out');
}
async function editSchema(value) {
  await page.waitFor(
    () => document.querySelector('[aria-label="Chat instructions"]')?.disabled === false,
  );
  await page.button('Chat instructions');
  await page.waitFor(
    () => !!document.querySelector('textarea[aria-describedby="output-schema-hint"]'),
  );
  await fill('textarea[aria-describedby="output-schema-hint"]', value);
  await page.button('Save instructions');
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.structured-output-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Structured QA')),
    'Not a disposable workspace',
  );
  const report = { checkedAt: new Date().toISOString(), chats: [] };
  for (const provider of ['claude', 'codex']) {
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `No existing ${provider} connection`);
    const status = await page.invoke('detect_connection', {
      provider,
      connectionId: connection.id,
    });
    assert.equal(status.auth, 'ready', `${provider} requires sign-in`);
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const chat = {
      id,
      title: `Structured QA ${provider} ${id.slice(0, 8)}`,
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
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: await mkdtemp(join(tmpdir(), 'studio-structured-')),
      },
      messages: [],
    };
    workspace.conversations.push(chat);
    report.chats.push({ id, title: chat.title, provider, version: status.version });
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => {
    window.structuredReload = true;
  });
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.structuredReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of report.chats) {
    await select(chat);
    await fill('[aria-label="Message"]', 'Draft preserved');
    await editSchema(schema('answer'));
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Draft preserved',
    );
    const first = await reply(
      chat,
      'Return answer READY as structured output. Do not use external tools or modify files.',
    );
    assert.deepEqual(JSON.parse(text(first)), { answer: 'READY' });
    const reused = await reply(
      chat,
      'Return answer REUSED as structured output. Do not use external tools or modify files.',
    );
    assert.deepEqual(JSON.parse(text(reused)), { answer: 'REUSED' });
    await editSchema(schema('status'));
    const changed = await reply(
      chat,
      'Return status CHANGED using the current schema. Do not use external tools or modify files.',
    );
    assert.deepEqual(JSON.parse(text(changed)), { status: 'CHANGED' });
    assert.equal(changed.settings.outputSchema, schema('status'));
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/native-${chat.provider}.png`, Buffer.from(shot.data, 'base64'));
    await editSchema('');
    const plain = await reply(
      chat,
      'Reply with exactly PLAIN as normal text, without JSON. Do not use tools or modify files.',
    );
    assert.equal(text(plain).trim(), 'PLAIN');
    assert.equal(plain.settings.outputSchema, undefined);
    chat.results = [first, reused, changed, plain].map((m) => ({
      status: m.status,
      text: text(m),
      schema: m.settings.outputSchema,
      durationMs: m.durationMs,
    }));
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(`${chat.provider}: initial, reused, changed schema, and disabled output passed`);
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
