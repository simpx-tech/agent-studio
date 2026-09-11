// Read-only metadata checks against real CLIs, isolated profiles and a local fixture MCP.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { nativePage } from './native-page.mjs';
import { workspaceSchema } from '../src/lib/domain.ts';

const page = await nativePage(9495);
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.context-mcp-qa',
  );
  await page.waitFor(() => !!document.querySelector('[aria-label="New conversation"]'));
  const workspace = await page.invoke('load_workspace');
  assert(workspace && workspace.conversations.every((c) => c.title.startsWith('Context MCP QA')));
  const identity = await page.invoke('get_installation');
  for (const account of workspace.fleet.accounts) account.purpose ??= 'personal';
  await mkdir('artifacts/context-mcp-native', { recursive: true });
  const folder = await mkdtemp(resolve('artifacts/context-mcp-native/project-'));
  await mkdir(join(folder, '.git'));
  const server = join(folder, 'fixture-mcp.mjs');
  const calls = join(folder, 'calls.jsonl');
  await writeFile(
    server,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const v = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: v.method }) + '\\n');
  if (v.id === undefined) return;
  let result = {};
  if (v.method === 'initialize') result = { protocolVersion: v.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'context-qa', version: '1' } };
  if (v.method === 'tools/list') result = { tools: [{ name: 'fixture_read', description: 'Private fixture tool description', inputSchema: { type: 'object' } }] };
  if (v.method === 'resources/list') result = { resources: [] };
  if (v.method === 'resources/templates/list') result = { resourceTemplates: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: v.id, result }) + '\\n');
});
`,
  );
  for (const name of ['CLAUDE.md', 'AGENTS.md'])
    await writeFile(join(folder, name), 'Metadata fixture. No tasks to execute.\n');
  const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
  const connections = {};
  for (const provider of ['codex', 'claude']) {
    const accountId = crypto.randomUUID(),
      id = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `${provider} context fixture`,
      provider,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id,
      accountId,
      environmentId: identity.id,
      profile: 'isolated',
    });
    connections[provider] = id;
  }
  await page.invoke('save_workspace', { workspace: workspaceSchema.parse(workspace) });
  for (const provider of ['codex', 'claude']) {
    const request = {
      provider,
      model: provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
      connectionId: connections[provider],
      location,
    };
    const initial = await page.invoke('read_context', request);
    const profile = resolve(initial.profile);
    assert(
      profile.includes(
        `${sep}com.vinicius.agentstudio.context-mcp-qa${sep}profiles${sep}${provider}${sep}`,
      ),
    );
    if (provider === 'codex') {
      await writeFile(
        join(profile, 'config.toml'),
        `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n[mcp_servers.fixture_mcp]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\n[mcp_servers.disabled_mcp]\nenabled = false\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\n`,
      );
      await mkdir(join(profile, 'memories/rollout_summaries'), { recursive: true });
      await writeFile(join(profile, 'memories/memory_summary.md'), 'Global memory fixture');
      await writeFile(
        join(profile, 'memories/MEMORY.md'),
        `- rollout_summaries/selected.md (cwd=${folder}, rollout_path=unused)\n- rollout_summaries/unrelated.md (cwd=${folder}-other, rollout_path=unused)\n`,
      );
      for (const name of ['selected.md', 'unrelated.md'])
        await writeFile(
          join(profile, 'memories/rollout_summaries', name),
          'Private fixture memory',
        );
    } else {
      const memory = join(profile, 'qa-memory');
      await mkdir(memory);
      await writeFile(join(memory, 'MEMORY.md'), 'Private fixture memory');
      await writeFile(join(memory, 'topic.md'), 'Private fixture topic');
      await writeFile(
        join(profile, 'settings.json'),
        JSON.stringify({ autoMemoryDirectory: memory }),
      );
      await writeFile(
        join(profile, '.claude.json'),
        JSON.stringify({
          mcpServers: { fixture_mcp: { command: process.execPath, args: [server] } },
        }),
      );
    }
    const snapshot = await page.invoke('read_context', request);
    const mcps = snapshot.entries.filter((e) => e.kind === 'mcps');
    assert(
      mcps.some((e) => e.name === 'fixture_mcp'),
      `${provider} fixture MCP missing; notes: ${snapshot.notes.join(' ')}`,
    );
    if (provider === 'codex') {
      assert(mcps.some((e) => e.name === 'disabled_mcp' && e.status === 'disabled'));
      assert.deepEqual(
        snapshot.entries.filter((e) => e.kind === 'memories').map((e) => e.name),
        ['memory_summary.md', 'MEMORY.md', 'selected.md'],
      );
    } else {
      assert(mcps.some((e) => e.name === 'fixture_mcp' && e.status === 'connected'));
      assert(snapshot.entries.some((e) => e.kind === 'memories' && e.name === 'MEMORY.md'));
      assert(snapshot.entries.some((e) => e.kind === 'memories' && e.name === 'topic.md'));
    }
    assert(!JSON.stringify(snapshot).includes('Private fixture'));
    report.providers[provider] = {
      mcps: mcps.map(({ name, status }) => ({ name, status })),
      memories: snapshot.entries.filter((e) => e.kind === 'memories').length,
      notes: snapshot.notes,
    };
    console.log(`${provider}: native MCP and memory inspection passed.`);
    const now = new Date().toISOString();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: `Context MCP QA ${provider}`,
      titleStatus: 'fallback',
      settings: {
        provider,
        model: request.model,
        reasoning: 'low',
        instructions: '',
        connectionId: connections[provider],
      },
      location,
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
  }
  const methods = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method);
  assert(methods.includes('initialize'));
  assert(!methods.includes('tools/call'));
  report.noToolExecution = true;
  await page.invoke('save_workspace', { workspace: workspaceSchema.parse(workspace) });
  await writeFile('artifacts/context-mcp-native-result.json', JSON.stringify(report, null, 2));
  await page.cdp('Page.reload');
  await page.waitFor(() =>
    [...document.querySelectorAll('[role="tab"]')].some((el) =>
      el.textContent.startsWith('History'),
    ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((el) => el.textContent.startsWith('History'))
      .click(),
  );
  await page.waitFor(() =>
    [...document.querySelectorAll('.conversation-item')].some((el) =>
      el.textContent.includes('Context MCP QA'),
    ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('.conversation-item')]
      .find((el) => el.textContent.includes('Context MCP QA codex'))
      .click(),
  );
  await page.button('Model context');
  await page.waitFor(
    () =>
      document.querySelector('.context-modal footer') &&
      !document.querySelector('[aria-label="Refresh model context"]').disabled,
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('.context-categories button')]
      .find((el) => el.textContent.startsWith('MCPs'))
      .click(),
  );
  assert(
    await page.evaluate(() =>
      document.querySelector('.context-entries').textContent.includes('fixture_mcp'),
    ),
  );
  assert(
    await page.evaluate(
      () =>
        document.querySelector('.context-modal').scrollWidth <=
        document.querySelector('.context-modal').clientWidth,
    ),
  );
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/context-mcps-native.png', Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  await writeFile('artifacts/context-mcp-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
