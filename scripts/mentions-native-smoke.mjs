// Opt-in real CLI checks in the isolated Mentions QA application. Consumes model usage.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const page = await nativePage(19661);
const appsOnly = process.argv.includes('--apps-only');
const report = appsOnly
  ? JSON.parse(await readFile('artifacts/mentions-native/results.json', 'utf8'))
  : { checkedAt: new Date().toISOString(), providers: {} };
await mkdir('artifacts/mentions-native', { recursive: true });
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.mentions-qa');
  await page.waitFor(
    () =>
      !!document.querySelector('[aria-label="New conversation"]') &&
      !document.querySelector('[aria-label="New conversation"]').disabled,
  );
  const identity = await page.invoke('get_installation');
  for (const provider of appsOnly ? ['codex'] : ['codex', 'claude']) {
    let workspace = await page.invoke('load_workspace');
    assert(
      workspace.conversations.every((c) => c.title.startsWith('Mentions QA')),
      'QA workspace must be disposable.',
    );
    const account = workspace.fleet.accounts.find(
      (a) =>
        a.provider === provider &&
        workspace.fleet.connections.some(
          (c) =>
            c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
        ),
    );
    assert(account, `Missing existing ${provider} connection`);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    const folder = await mkdtemp(join(tmpdir(), 'studio-mentions-'));
    const marker = crypto.randomUUID();
    await writeFile(join(folder, 'qa mention.txt'), marker);
    const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
    const args = {
      provider,
      connectionId: connection.id,
      conversationId: null,
      location,
      kind: 'file',
      query: 'qa',
    };
    const files = await page.invoke('search_mentions', args);
    assert.equal(files.entries.length, 1);
    assert.equal(files.entries[0].name, 'qa mention.txt');
    assert.equal(files.entries[0].token, '@"qa mention.txt"');
    assert(!JSON.stringify(files).includes(marker));
    const empty = await page.invoke('search_mentions', { ...args, query: 'does-not-exist-123' });
    assert.equal(empty.entries.length, 0);
    if (provider === 'codex') {
      const apps = await page.evaluate(
        async (args) => {
          try {
            return { result: await window.__TAURI_INTERNALS__.invoke('search_mentions', args) };
          } catch (error) {
            return { error: String(error).slice(0, 1000) };
          }
        },
        { ...args, kind: 'app', query: '' },
      );
      report.apps = apps.result
        ? {
            accessibleEnabledCount: apps.result.entries.length,
            truncated: apps.result.truncated,
            readOnly: true,
          }
        : { unavailable: apps.error, readOnly: true };
      console.log(JSON.stringify({ apps: report.apps }));
      if (appsOnly) {
        await writeFile('artifacts/mentions-native/results.json', JSON.stringify(report, null, 2));
        assert(!apps.error, apps.error);
        break;
      }
    }
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      title = `Mentions QA ${provider} ${id.slice(0, 8)}`;
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      settings: {
        connectionId: connection.id,
        provider,
        model: provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
        reasoning: 'low',
        instructions: '',
      },
      location,
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    await page.invoke('save_workspace', { workspace });
    await page.evaluate(() => {
      window.mentionsQaReload = true;
    });
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.mentionsQaReload &&
        !!document.querySelector('[aria-label="New conversation"]') &&
        !document.querySelector('[aria-label="New conversation"]').disabled,
    );
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((e) => e.textContent.includes('History'))
        .click(),
    );
    await page.waitFor(
      (title) =>
        [...document.querySelectorAll('.conversation-item')].some((e) =>
          e.textContent.includes(title),
        ),
      title,
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((e) => e.textContent.includes(title))
          .click(),
      title,
    );
    await page.waitFor(
      () =>
        !!document.querySelector('[aria-label="Message"]') &&
        !document.querySelector('[aria-label="Message"]').disabled,
    );
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Message"]');
      input.focus();
      input.value = 'Read @qa';
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => !!document.querySelector('[role="option"][aria-label="qa mention.txt"]'),
    );
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/mentions-native/${provider}-picker.png`,
      Buffer.from(shot.data, 'base64'),
    );
    await page.click('[role="option"][aria-label="qa mention.txt"]');
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Read @"qa mention.txt" ',
    );
    workspace = await page.invoke('load_workspace');
    assert.equal(workspace.conversations.find((c) => c.id === id).messages.length, 0);
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value +=
        'and reply only with the marker inside it. Do not edit files, contact external services, or delegate.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () =>
        !!document.querySelector('[aria-label="Send message"]') &&
        !document.querySelector('[aria-label="Send message"]').disabled,
    );
    await page.click('[aria-label="Send message"]');
    console.log(`Submitted real ${provider} file mention.`);
    const deadline = Date.now() + 180_000;
    let saved;
    while (Date.now() < deadline) {
      workspace = await page.invoke('load_workspace');
      saved = workspace.conversations.find((c) => c.id === id);
      if (saved.messages.at(-1)?.role === 'assistant' && saved.messages.at(-1).status !== 'running')
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const reply = saved.messages.at(-1);
    assert.equal(reply.status, 'complete', reply.error ?? 'Reply did not finish');
    assert(
      reply.blocks
        .filter((b) => b.type === 'markdown')
        .map((b) => b.text)
        .join('\n')
        .includes(marker),
      'Real provider did not read the selected file',
    );
    assert.equal(saved.messages[0].mentions?.length ?? 0, provider === 'codex' ? 1 : 0);
    report.providers[provider] = {
      fileSearch: true,
      missingFileEmpty: true,
      draftOnly: true,
      fileRead: true,
      nativeMetadataSaved: provider === 'codex',
    };
    await writeFile('artifacts/mentions-native/results.json', JSON.stringify(report, null, 2));
    console.log(`Verified real ${provider} file search, picker and file read.`);
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
