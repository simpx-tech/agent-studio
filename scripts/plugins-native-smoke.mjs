// Native IPC and rendered controls with isolated, unsigned-in CLI profiles. No paid prompts.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { nativePage } from './native-page.mjs';
import { workspaceSchema } from '../src/lib/domain.ts';
const page = await nativePage(9537, 'http://127.0.0.1:1447/');
async function invoke(command, args) {
  const response = await page.evaluate(
    async (command, args) => {
      try {
        return { result: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (error) {
        return { error: String(error) };
      }
    },
    command,
    args,
  );
  if (response.error) throw new Error(response.error);
  return response.result;
}
const output = resolve('artifacts/plugins-native');
const report = { checkedAt: new Date().toISOString(), checks: [] };
try {
  assert.equal(await invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.plugins-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const workspace = await invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Plugins QA')));
  const identity = await invoke('get_installation');
  const project = await mkdtemp(join(output, 'project-'));
  const skillFolder = join(project, '.agents/skills/native-fixture');
  await mkdir(skillFolder, { recursive: true });
  await writeFile(
    join(skillFolder, 'SKILL.md'),
    '---\nname: native-fixture\ndescription: Native plugin test fixture\n---\nNo actions required.\n',
  );
  const location = { computerId: identity.computerId, environmentId: identity.id, path: project };
  const ids = {};
  for (const provider of ['claude', 'codex']) {
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `Plugins QA ${provider}`,
      provider,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: identity.id,
      profile: 'isolated',
    });
    const conversationId = crypto.randomUUID(),
      now = new Date().toISOString();
    workspace.conversations.push({
      id: conversationId,
      title: `Plugins QA ${provider}`,
      createdAt: now,
      updatedAt: now,
      location,
      settings: { provider, connectionId, model: '', reasoning: '', instructions: '' },
      messages: [],
    });
    ids[provider] = { provider, connectionId, conversationId, location };
  }
  await invoke('save_workspace', { workspace: workspaceSchema.parse(workspace) });
  for (const provider of ['claude', 'codex']) {
    const selection = ids[provider];
    const list = await invoke('manage_plugins', { ...selection, action: { kind: 'list' } });
    assert.equal(list.plugins.length, 0);
    assert.deepEqual(list.skillRoots, []);
    await assert.rejects(
      invoke('manage_plugins', { ...selection, action: { kind: 'install', id: '--all' } }),
      /Invalid plugin/,
    );
    report.checks.push(`${provider}: isolated native inventory and invalid-action rejection`);
  }
  const selection = ids.codex;
  const context = await invoke('read_context', { ...selection, model: '' });
  const skill = context.entries.find((e) => e.kind === 'skills' && e.name === 'native-fixture');
  assert(skill, 'Native skill discovered');
  for (const enabled of [false, true]) {
    await invoke('manage_plugins', {
      ...selection,
      action: { kind: 'skill', path: skill.path, enabled },
    });
    const refreshed = await invoke('read_context', { ...selection, model: '' });
    assert.equal(
      refreshed.entries.find((e) => e.path === skill.path).status,
      enabled ? 'reported' : 'disabled',
    );
  }
  await assert.rejects(
    invoke('manage_plugins', {
      ...selection,
      action: { kind: 'skill', path: join(project, 'foreign/SKILL.md'), enabled: false },
    }),
    /current inventory/,
  );
  const roots = join(project, 'extra-roots');
  await mkdir(join(roots, 'extra-fixture'), { recursive: true });
  await writeFile(
    join(roots, 'extra-fixture/SKILL.md'),
    '---\nname: extra-fixture\ndescription: Temporary source fixture\n---\nNo actions required.\n',
  );
  await invoke('manage_plugins', {
    ...selection,
    action: { kind: 'runtime', pluginDirs: [], pluginUrls: [], skillRoots: [roots] },
  });
  const withRoots = await invoke('read_context', { ...selection, model: '' });
  assert(withRoots.entries.some((e) => e.name === 'extra-fixture'));
  const other = await invoke('read_context', { ...selection, conversationId: null, model: '' });
  assert(!other.entries.some((e) => e.name === 'extra-fixture'));
  report.checks.push(
    'Codex: real skill disable/enable, foreign path rejection, per-conversation temporary roots',
  );
  await page.cdp('Page.reload');
  await page.waitFor(() =>
    [...document.querySelectorAll('button')].some((b) => b.innerText.includes('Plugins QA codex')),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((b) => b.innerText.includes('Plugins QA codex'))
      .click(),
  );
  await page.button('Model context');
  await page.button('Plugins');
  await page.waitFor(() =>
    document.querySelector('.plugin-management')?.textContent.includes('No installed plugins'),
  );
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'native-plugins.png'), Buffer.from(data, 'base64'));
  assert.equal(page.errors.length, 0);
  report.checks.push('Native Plugins tab rendered without JavaScript errors');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
