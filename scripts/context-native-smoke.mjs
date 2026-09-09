// Read-only provider metadata queries in an isolated native app. No model replies requested.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9447);
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.context-qa');
  await page.waitFor(() => !!document.querySelector('[aria-label="New conversation"]'));
  const workspace = await page.invoke('load_workspace');
  assert(workspace && workspace.conversations.every((c) => c.title.startsWith('Context QA')));
  const identity = await page.invoke('get_installation');
  await mkdir('artifacts/context-native', { recursive: true });
  const folder = await mkdtemp(resolve('artifacts/context-native/project-'));
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
    await writeFile(
      join(folder, name),
      'Context inventory fixture. No tasks need to be executed.\n',
    );
  for (const scope of ['.claude', '.agents']) {
    const skill = join(folder, scope, 'skills', 'context-fixture');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: context-fixture\ndescription: Synthetic context inventory fixture\n---\nNo actions needed.\n',
    );
  }
  const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
  const connections = {};
  for (const provider of ['claude', 'codex', 'gemini']) {
    const accountId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `${provider} context QA`,
      provider,
      purpose: 'personal',
    });
    const connection = {
      id: crypto.randomUUID(),
      accountId,
      environmentId: identity.id,
      profile: 'existing',
    };
    workspace.fleet.connections.push(connection);
    connections[provider] = connection.id;
  }
  await page.invoke('save_workspace', { workspace });
  for (const [provider, models] of [
    ['claude', ['sonnet', 'opus']],
    ['codex', ['gpt-5.6-sol', 'gpt-6-astra']],
    ['gemini', ['gemini-3.8-flash']],
  ]) {
    const snapshots = [];
    for (const model of models) {
      const snapshot = await page.invoke('read_context', {
        provider,
        model,
        connectionId: connections[provider],
        location,
      });
      assert.equal(snapshot.provider, provider);
      assert.equal(snapshot.model, model);
      assert.equal(snapshot.folder, folder);
      assert(snapshot.entries.some((e) => e.kind === 'instructions' && e.path.startsWith(folder)));
      if (provider !== 'gemini') {
        assert(
          !snapshot.notes.some((n) => /query failed/.test(n)),
          `${provider}: metadata query failed`,
        );
        assert(
          snapshot.entries.some((e) => e.kind === 'skills' && e.path.includes('context-fixture')),
        );
      }
      if (provider === 'codex')
        assert(snapshot.entries.some((e) => e.kind === 'skills' && e.status === 'reported'));
      snapshots.push(snapshot);
    }
    report.providers[provider] = snapshots.map((s) => ({
      model: s.model,
      execution: s.execution,
      instructions: s.entries.filter((e) => e.kind === 'instructions').length,
      skills: s.entries.filter((e) => e.kind === 'skills').length,
      memories: s.entries.filter((e) => e.kind === 'memories').length,
      reported: s.entries.filter((e) => e.status === 'reported').length,
      truncated: s.truncated,
    }));
    console.log(`${provider}: ${snapshots.length} native context inspections passed.`);
  }
  const isolatedAccount = crypto.randomUUID(),
    isolatedConnection = crypto.randomUUID();
  workspace.fleet.accounts.push({
    id: isolatedAccount,
    name: 'Isolated context QA',
    provider: 'codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: isolatedConnection,
    accountId: isolatedAccount,
    environmentId: identity.id,
    profile: 'isolated',
  });
  await page.invoke('save_workspace', { workspace });
  const isolated = await page.invoke('read_context', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    connectionId: isolatedConnection,
    location,
  });
  assert(isolated.profile.includes(isolatedConnection));
  assert(!isolated.entries.some((e) => e.kind === 'memories'));
  report.isolatedProfile = true;
  await assert.rejects(
    page.invoke('read_context', {
      provider: 'claude',
      model: 'sonnet',
      connectionId: connections.codex,
      location,
    }),
  );
  await assert.rejects(
    page.invoke('read_context', {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      connectionId: connections.codex,
      location: { ...location, path: join(folder, 'missing') },
    }),
  );
  report.invalidSelectionsRejected = true;
  const now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Context QA — Claude',
    titleStatus: 'fallback',
    settings: {
      provider: 'claude',
      model: 'sonnet',
      reasoning: 'low',
      instructions: 'Follow the selected project’s conventions.',
      connectionId: connections.claude,
    },
    location,
    createdAt: now,
    updatedAt: now,
    messages: [],
  });
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(() =>
    [...document.querySelectorAll('.conversation-item')].some((el) =>
      el.textContent.includes('Context QA'),
    ),
  );
  await page.evaluate(() => [...document.querySelectorAll('.conversation-item')].at(-1).click());
  await page.button('Model context');
  await page.waitFor(() => document.querySelector('.context-modal footer'));
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.context-modal').scrollWidth <=
        document.querySelector('.context-modal').clientWidth,
    ),
    true,
  );
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/context-native.png', Buffer.from(screenshot.data, 'base64'));
  report.errors = page.errors;
  assert.deepEqual(page.errors, []);
  await writeFile('artifacts/context-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
