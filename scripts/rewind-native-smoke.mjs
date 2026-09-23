// Opt-in real Windows provider proof. Only scripts/native-rewind.tauri.json on CDP 9593.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/rewind';
const identifier = 'com.vinicius.agentstudio.rewind-qa';
const data = join(process.env.LOCALAPPDATA, identifier);
await mkdir(output, { recursive: true });
const page = await nativePage(9593);
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
const saved = async (chat) =>
  (await page.invoke('load_workspace')).conversations.find((c) => c.id === chat.id);
const binding = async (chat) =>
  JSON.parse(await readFile(join(data, 'native-sessions', `${chat.id}.json`), 'utf8'));
async function select(chat) {
  for (const name of ['History', 'Active']) {
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll('[role="tab"]')]
          .find((e) => e.textContent.includes(name))
          ?.click(),
      name,
    );
    if (
      await page.evaluate((title) => {
        const e = [...document.querySelectorAll('.conversation-item')].find((e) =>
          e.textContent.includes(title),
        );
        e?.click();
        return !!e;
      }, chat.title)
    )
      return;
  }
  throw Error('QA conversation is unavailable');
}
async function submit(chat, prompt) {
  const before = (await saved(chat)).messages.length;
  await type(prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const conversation = await saved(chat),
      m = conversation.messages.at(-1);
    if (
      conversation.messages.length > before &&
      m?.role === 'assistant' &&
      m.status !== 'running'
    ) {
      assert.equal(m.status, 'complete', m.error);
      return m;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Reply timed out');
}
async function screenshot(name) {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
}
async function rewindAt(position = -1) {
  await page.waitFor(
    (position) =>
      [...document.querySelectorAll('button')]
        .filter((e) => e.textContent.trim() === 'Rewind here')
        .at(position)?.disabled === false,
    position,
  );
  await page.evaluate(
    (position) =>
      [...document.querySelectorAll('button')]
        .filter((e) => e.textContent.trim() === 'Rewind here')
        .at(position)
        .click(),
    position,
  );
  await page.waitFor(() => !!document.querySelector('dialog[open]'));
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Rewind QA')),
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
      folder = await mkdtemp(join(tmpdir(), `studio-rewind-${provider}-`));
    const chat = {
      id,
      title: `Rewind QA ${provider} ${id.slice(0, 8)}`,
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
    report.chats.push({ id, title: chat.title, provider, folder });
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.rewindReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.rewindReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of report.chats) {
    await select(chat);
    const first = await submit(
      chat,
      'Use the file editing tool to create rewind-proof.txt containing exactly ORIGINAL followed by one newline. Use Write or apply_patch, never a shell command to write it. Then reply CREATED.',
    );
    assert.equal(await readFile(join(chat.folder, 'rewind-proof.txt'), 'utf8'), 'ORIGINAL\n');
    assert(first.fileChanges?.edits.length, 'Provider did not report a file edit');
    const initial = await binding(chat);
    const marker = `DISCARDED_${crypto.randomUUID().slice(0, 8)}`;
    await submit(
      chat,
      `Remember this codeword: ${marker}. Reply REMEMBERED. Do not use tools or change any files.`,
    );
    await type('Draft survives rewind');
    await rewindAt();
    await screenshot(`native-${chat.provider}-rewind`);
    await page.button('Rewind');
    await page.waitFor(
      () =>
        !document.querySelector('dialog[open]') &&
        document.querySelectorAll('.message').length === 2,
    );
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Draft survives rewind',
    );
    await page.button('Undo rewind');
    await page.waitFor(() => document.querySelectorAll('.message').length === 4);
    // Undo rewind restores exactly the history the native session received, so it resumes.
    const resumed = await submit(chat, 'Reply RESUMED. Do not use tools or change any files.');
    assert(text(resumed).includes('RESUMED'), text(resumed));
    assert.equal((await binding(chat)).id, initial.id);
    await rewindAt(-2);
    await page.button('Rewind');
    await page.waitFor(() => document.querySelectorAll('.message').length === 2);
    const next = await submit(
      chat,
      'Did I give you a codeword to remember? If no codeword is in this conversation, reply exactly NO_CODEWORD. Do not use tools or inspect old sessions.',
    );
    assert(text(next).includes('NO_CODEWORD') && !text(next).includes(marker), text(next));
    const revised = await binding(chat);
    assert.notEqual(revised.id, initial.id);
    assert.equal(revised.history_revision, 3);
    assert.equal((await saved(chat)).rewind, undefined);
    // Real file conflict refusal followed by confirmed restoration through the UI.
    await writeFile(join(chat.folder, 'rewind-proof.txt'), 'LATER USER EDIT\n');
    await page.button('Undo edits');
    await page.waitFor(() => !!document.querySelector('dialog[open] [role="alert"]'));
    assert(
      (await page.evaluate(() => document.querySelector('dialog').textContent)).includes(
        'has changed',
      ),
    );
    assert.equal(
      await readFile(join(chat.folder, 'rewind-proof.txt'), 'utf8'),
      'LATER USER EDIT\n',
    );
    await page.button('Cancel');
    await writeFile(join(chat.folder, 'rewind-proof.txt'), 'ORIGINAL\n');
    await page.button('Undo edits');
    await page.waitFor(
      () => document.querySelector('dialog[open] li')?.textContent === 'rewind-proof.txt',
    );
    await screenshot(`native-${chat.provider}-undo`);
    await page.evaluate(() =>
      [...document.querySelectorAll('dialog button')]
        .find((e) => e.textContent.trim() === 'Undo edits')
        .click(),
    );
    await page.waitFor(() => !document.querySelector('dialog[open]'));
    assert(!existsSync(join(chat.folder, 'rewind-proof.txt')));
    const final = await saved(chat);
    assert(final.messages.find((m) => m.runId === first.runId).filesUndone);
    assert.equal(final.messages.length, 4);
    chat.result = {
      originalSession: initial.id,
      rewoundSession: revised.id,
      discardedContextAbsent: true,
      draftRetained: true,
      rewindRestored: true,
      undoRewindResumedSession: true,
      fileConflictRefused: true,
      createdFileRemoved: true,
    };
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `${chat.provider}: Rewind, Undo rewind resuming its session, fresh context, later-edit refusal, and file Undo passed`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
