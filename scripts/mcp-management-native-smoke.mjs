// Real installed CLI add, OAuth, cancellation, logout and reload in isolated profiles.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
import { workspaceSchema } from '../src/lib/domain.ts';
const output = 'artifacts/mcp-management';
await mkdir(output, { recursive: true });
const { origin } = JSON.parse(await readFile(`${output}/fixture.json`, 'utf8'));
const page = await nativePage(9507);
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.mcp-management-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('MCP QA')));
  const identity = await page.invoke('get_installation');
  const folder = await mkdtemp(join(tmpdir(), 'studio-mcp-management-'));
  const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
  for (const provider of ['claude', 'codex']) {
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `MCP QA ${provider}`,
      provider,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: identity.id,
      profile: 'isolated',
    });
    await page.invoke('save_workspace', { workspace: workspaceSchema.parse(workspace) });
    const selection = { provider, connectionId, location, conversationId: null };
    const call = async (action) => {
      const value = await page.evaluate(
        async (args) => {
          try {
            return { result: await window.__TAURI_INTERNALS__.invoke('manage_mcp', args) };
          } catch (error) {
            return { error: String(error) };
          }
        },
        { ...selection, action },
      );
      if (value.error) throw new Error(value.error);
      return value.result;
    };
    const name = 'qa_oauth';
    const added = await call({ kind: 'add', name, server: { type: 'http', url: `${origin}/mcp` } });
    assert.equal(added.status, 'complete');
    await assert.rejects(
      call({ kind: 'add', name, server: { type: 'http', url: `${origin}/mcp` } }),
      /already exists/,
    );
    const before = await call({ kind: 'status' });
    assert(before.servers.some((s) => s.name === name));
    const started = await call({ kind: 'authenticate', name });
    assert.equal(started.status, 'pending');
    assert(started.authorizationUrl.startsWith(origin));
    assert.equal(
      (await call({ kind: 'poll', operationId: started.operationId })).status,
      'pending',
    );
    // Open the synthetic authorization endpoint and follow the CLI's real loopback callback.
    const response = await fetch(started.authorizationUrl);
    assert(response.ok);
    let finished;
    for (let n = 0; n < 20; n++) {
      finished = await call({ kind: 'poll', operationId: started.operationId });
      if (finished.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(finished.status, 'complete', finished.message);
    assert.equal(finished.authorizationUrl, undefined);
    assert.equal((await call({ kind: 'logout', name })).status, 'complete');
    const cancelled = await call({ kind: 'authenticate', name });
    assert.equal(
      (await call({ kind: 'cancel', operationId: cancelled.operationId })).status,
      'cancelled',
    );
    if (provider === 'codex') assert.equal((await call({ kind: 'reload' })).status, 'complete');
    await assert.rejects(
      call({ kind: 'toggle', name, enabled: false }),
      /idle live chat|Claude only/,
    );
    const inspected = await page.invoke('read_context', { ...selection, model: '' });
    assert(inspected.entries.some((e) => e.kind === 'mcps' && e.name === name));
    report.providers[provider] = {
      add: true,
      duplicateRejected: true,
      oauthConfirmed: true,
      cancelled: true,
      logout: true,
      profile: 'isolated',
    };
  }
  const methods = await readFile(`${output}/methods.jsonl`, 'utf8');
  assert(!methods.includes('tools/call'));
  await writeFile(`${output}/native-result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  page.close();
}
