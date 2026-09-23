// Opt-in real Windows Codex add/edit/delete Undo proof in the dedicated QA app.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9593);
const output = 'artifacts/rewind';
await mkdir(output, { recursive: true });
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.rewind-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Rewind QA')),
    'Not a disposable workspace',
  );
  const account = workspace.fleet.accounts.find((a) => a.provider === 'codex');
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
  );
  assert(connection);
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'codex', connectionId: connection.id }))
      .auth,
    'ready',
  );
  const folder = await mkdtemp(join(tmpdir(), 'studio-undo-codex-'));
  await writeFile(join(folder, 'undo-existing.txt'), 'BEFORE\n');
  await writeFile(join(folder, 'undo-delete.txt'), 'DELETE\n');
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const chat = {
    id,
    title: `Rewind QA multi-file ${id.slice(0, 8)}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'low',
      instructions: '',
      connectionId: connection.id,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  };
  workspace.conversations.push(chat);
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.undoReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.undoReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('History'))
      .click(),
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value =
      'Use apply_patch to do exactly these three file changes: create undo-added.txt containing ADDED and one newline; change undo-existing.txt from BEFORE and one newline to AFTER and one newline; delete undo-delete.txt, whose contents are DELETE and one newline. Use the file editing tool, never shell commands to change files. Then reply DONE.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const saved = async () =>
    (await page.invoke('load_workspace')).conversations.find((c) => c.id === id);
  let response;
  for (const deadline = Date.now() + 240000; Date.now() < deadline;) {
    response = (await saved()).messages.at(-1);
    if (response?.role === 'assistant' && response.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.equal(response.status, 'complete', response.error);
  assert.equal(await readFile(join(folder, 'undo-added.txt'), 'utf8'), 'ADDED\n');
  assert.equal(await readFile(join(folder, 'undo-existing.txt'), 'utf8'), 'AFTER\n');
  assert(!existsSync(join(folder, 'undo-delete.txt')));
  await writeFile(join(folder, 'undo-existing.txt'), 'LATER USER EDIT\n');
  await page.button('Undo edits');
  await page.waitFor(() => !!document.querySelector('dialog[open] [role="alert"]'));
  assert(
    (await page.evaluate(() => document.querySelector('dialog').textContent)).includes(
      'has changed',
    ),
  );
  assert.equal(await readFile(join(folder, 'undo-existing.txt'), 'utf8'), 'LATER USER EDIT\n');
  assert(existsSync(join(folder, 'undo-added.txt')));
  assert(!existsSync(join(folder, 'undo-delete.txt')));
  await page.button('Cancel');
  await writeFile(join(folder, 'undo-existing.txt'), 'AFTER\n');
  await page.button('Undo edits');
  await page.waitFor(() => document.querySelectorAll('dialog[open] li').length === 3);
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native-codex-multi-file-undo.png`, Buffer.from(shot.data, 'base64'));
  await page.evaluate(() =>
    [...document.querySelectorAll('dialog button')]
      .find((e) => e.textContent.trim() === 'Undo edits')
      .click(),
  );
  await page.waitFor(() => !document.querySelector('dialog[open]'));
  assert(!existsSync(join(folder, 'undo-added.txt')));
  assert.equal(await readFile(join(folder, 'undo-existing.txt'), 'utf8'), 'BEFORE\n');
  assert.equal(await readFile(join(folder, 'undo-delete.txt'), 'utf8'), 'DELETE\n');
  const final = await saved();
  assert(final.messages.at(-1).filesUndone);
  assert.equal(final.historyRevision, 1);
  assert.equal(final.messages.length, 2);
  await writeFile(join(folder, 'undo-existing.txt'), 'AFTER UNDO USER EDIT\n');
  const duplicate = await page.invoke('undo_files', {
    conversationId: id,
    runId: response.runId,
    connectionId: connection.id,
    commit: true,
  });
  assert(duplicate.undone);
  assert.equal(await readFile(join(folder, 'undo-existing.txt'), 'utf8'), 'AFTER UNDO USER EDIT\n');
  await page.evaluate(() => (window.undoReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.undoReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  assert((await saved()).messages.at(-1).filesUndone);
  assert.equal((await saved()).historyRevision, 1);
  assert.deepEqual(page.errors, []);
  await writeFile(
    `${output}/native-multi-file-report.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        conversation: id,
        run: response.runId,
        folder,
        addEditDeleteRestored: true,
        conflictRefusedBeforeWrites: true,
        receiptSurvivesReload: true,
        duplicateRequestPreservesLaterEdit: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'Codex native add/edit/delete Undo, later-edit refusal, reload receipt and idempotent retry passed',
  );
} finally {
  page.close();
}
