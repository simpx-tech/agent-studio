// Opt-in live provider proof. Use native-forks.tauri.json, an isolated Cargo
// target/WebView profile, and CDP port 9588. Never run against the user's app.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
const identifier = 'com.vinicius.agentstudio.forks-qa';
const directory = join(process.env.LOCALAPPDATA, identifier);
const output = 'artifacts/forks';
await mkdir(output, { recursive: true });
const page = await nativePage(9588);
const report = { checkedAt: new Date().toISOString(), chats: [] };
const text = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
const binding = (id) => join(directory, 'native-sessions', `${id}.json`);
const type = (value) =>
  page.evaluate((value) => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
async function send(id, value, previousCount) {
  await type(value);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const chat = (await page.invoke('load_workspace')).conversations.find((c) => c.id === id);
    const m = chat.messages.at(-1);
    if (chat.messages.length > previousCount && m?.role === 'assistant' && m.status !== 'running') {
      assert.equal(m.status, 'complete', m.error);
      return m;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Reply timed out');
}
async function select(title, scope) {
  await page.evaluate(
    (scope) =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((e) => e.textContent.includes(scope))
        ?.click(),
    scope,
  );
  await page.waitFor(
    (title) => [...document.querySelectorAll('.conversation-item')].some((e) => e.title === title),
    title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].find((e) => e.title === title).click(),
    title,
  );
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Fork QA')),
    'Not a disposable workspace',
  );
  const sources = [];
  for (const provider of ['claude', 'codex']) {
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `Missing ${provider} connection`);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const source = {
      id,
      title: `Fork QA ${provider} ${id.slice(0, 8)}`,
      titleStatus: 'generated',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: 'For this test reply concisely without tools.',
        connectionId: connection.id,
      },
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: provider === 'codex' ? '' : await mkdtemp(join(tmpdir(), 'studio-fork-')),
      },
      messages: [],
    };
    sources.push(source);
    workspace.conversations.push(source);
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.forkReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.forkReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const source of sources) {
    await select(source.title, 'History');
    const marker = `FORK_${crypto.randomUUID().slice(0, 8)}`;
    await send(source.id, `Remember the marker ${marker}. Reply only READY.`, 0);
    const original = (await page.invoke('load_workspace')).conversations.find(
      (c) => c.id === source.id,
    );
    const originalBinding = await readFile(binding(source.id), 'utf8');
    await type('Unsent source draft');
    await page.button('Fork conversation');
    await page.waitFor(() =>
      document.querySelector('.page-title')?.textContent?.includes('(fork)'),
    );
    const fork = (await page.invoke('load_workspace')).conversations.find(
      (c) => c.title === `${source.title} (fork)`,
    );
    assert(fork && fork.id !== source.id);
    assert.deepEqual(fork.settings, original.settings);
    assert.deepEqual(fork.location, original.location);
    assert.equal(fork.messages.length, 2);
    assert.equal(existsSync(binding(fork.id)), false, 'Fork must not start a provider');
    if (!source.location.path) {
      const inspected = await page.invoke('read_context', {
        provider: fork.settings.provider,
        model: fork.settings.model,
        connectionId: fork.settings.connectionId,
        conversationId: fork.id,
        forked: true,
      });
      assert.equal(
        normalize(inspected.folder).toLowerCase(),
        normalize(join(directory, 'standalone', fork.id)).toLowerCase(),
      );
      await writeFile(join(directory, 'standalone', source.id, 'source-only.txt'), marker);
      assert.equal(existsSync(join(inspected.folder, 'source-only.txt')), false);
    }
    const answer = await send(fork.id, 'What is the marker? Reply only with the exact marker.', 2);
    assert(text(answer).includes(marker), text(answer));
    const forkBinding = JSON.parse(await readFile(binding(fork.id), 'utf8'));
    if (!source.location.path) {
      const folderBinding = JSON.parse(
        await readFile(join(directory, 'standalone-bindings', `${fork.id}.json`), 'utf8'),
      );
      assert.equal(
        folderBinding.directory,
        'dedicated',
        'Standalone forks must receive their own working folder',
      );
    }
    assert.notEqual(forkBinding.id, JSON.parse(originalBinding).id);
    assert.equal(await readFile(binding(source.id), 'utf8'), originalBinding);
    assert.deepEqual(
      (await page.invoke('load_workspace')).conversations.find((c) => c.id === source.id),
      original,
    );
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `${output}/native-${source.settings.provider}.png`,
      Buffer.from(shot.data, 'base64'),
    );
    await select(source.title, 'Active');
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Unsent source draft',
    );
    report.chats.push({
      provider: source.settings.provider,
      sourceId: source.id,
      forkId: fork.id,
      independentNativeSession: true,
      recalledMarker: true,
      sourceUnchanged: true,
      draftPreserved: true,
    });
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `${source.settings.provider}: independent native fork, history recall, unchanged source, and preserved draft passed`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
