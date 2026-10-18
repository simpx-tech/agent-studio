// Real installed Claude Code and Codex answer a screen's MCP calls in the native app (docs/
// SCREENS.md). Each provider gets an isolated account whose profile receives a local stdio probe
// server through MCP management; a screen of that account declares the probe's tools, which are
// refused until allowed, then answer through manage_screen and from the screen's own page.
// Build and launch scripts/native-screens-mcp.tauri.json first (CDP 19891). Needs no login.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
import { workspaceSchema } from '../src/lib/domain.ts';

const identifier = 'com.vinicius.agentstudio.screens-mcp-qa';
const output = 'artifacts/screens-mcp';
await mkdir(output, { recursive: true });

// The same probe as the opt-in Rust tests (src-tauri/src/screens/mcp.rs).
const probe = `import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const tools = ['echo', 'big', 'fail', 'structured'].map((name) => ({ name, inputSchema: { type: 'object' } }));
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } });
  if (m.method === 'tools/list') return reply({ tools });
  if (m.method !== 'tools/call') return m.id === undefined ? undefined : reply({});
  const a = m.params.arguments ?? {};
  if (m.params.name === 'echo') return reply({ content: [{ type: 'text', text: JSON.stringify({ args: a, cwd: process.cwd(), pid: process.pid }) }] });
  if (m.params.name === 'big') return reply({ content: [{ type: 'text', text: 'x'.repeat(a.n - 3) + 'END' }] });
  if (m.params.name === 'fail') return reply({ isError: true, content: [{ type: 'text', text: 'It failed on purpose' }] });
  if (m.params.name === 'structured') return reply({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool ' + m.params.name } });
});
`;
// A page that calls two tools as it opens and keeps what it received.
const html = `<p id="out">Calling…</p><script>
(async () => {
  try {
    const echoed = await studio.mcp('probe', 'echo', { text: 'from the page' });
    const structured = await studio.mcpJson('probe', 'structured', {});
    await studio.save('result', { text: echoed.text, structured });
    document.getElementById('out').textContent = 'Done';
  } catch (error) {
    await studio.save('result', { error: error.message });
  }
})();
</script>`;

const page = await nativePage(19891);
const report = { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.quitOnClose();
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''), '');
  const identity = await page.invoke('get_installation');
  const folder = await mkdtemp(join(tmpdir(), 'studio-screens-mcp-'));
  const script = join(folder, 'probe.mjs');
  await writeFile(script, probe);
  const screens = join(process.env.LOCALAPPDATA, identifier, 'screens');
  await mkdir(screens, { recursive: true });
  // A rejected invoke reaches the driver as its message.
  const call = async (command, args) => {
    const value = await page.evaluate(
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
    if (value.error !== undefined) throw new Error(value.error);
    return value.result;
  };
  const ask = (request) => call('manage_screen', { environmentId: identity.id, request });
  for (const provider of ['claude', 'codex']) {
    // An isolated account of its own, sharing nothing, so the user's logins and servers stay out.
    const workspace = await page.invoke('load_workspace');
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `Screens QA ${provider}`,
      provider,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: identity.id,
      profile: 'isolated',
      sharedContext: 'none',
    });
    await page.invoke('save_workspace', { workspace: workspaceSchema.parse(workspace) });
    const location = { computerId: identity.computerId, environmentId: identity.id, path: folder };
    const added = await call('manage_mcp', {
      provider,
      connectionId,
      location,
      conversationId: null,
      action: {
        kind: 'add',
        name: 'probe',
        server: { type: 'stdio', command: process.execPath, args: [script] },
      },
    });
    assert.equal(added.status, 'complete', added.message);
    const id = crypto.randomUUID();
    const time = new Date().toISOString();
    await writeFile(
      join(screens, `${id}.json`),
      JSON.stringify({
        id,
        revision: 1,
        title: `Screens QA ${provider}`,
        description: '',
        html,
        actions: [],
        mcpTools: ['echo', 'big', 'fail', 'structured', 'nope'].map((tool) => ({
          server: 'probe',
          tool,
        })),
        site: { environmentId: identity.id, folder, project: folder },
        account: { provider, connectionId },
        conversationId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        createdAt: time,
        updatedAt: time,
      }),
    );
    const detail = await ask({ op: 'read', id });
    assert.equal(detail.allowed, false);
    assert.equal(detail.tools, 5);
    assert.deepEqual(detail.account, { provider, connectionId });
    const tool = (name, args = {}) =>
      ask({ op: 'mcp', id, server: 'probe', tool: name, arguments: args });
    await assert.rejects(tool('echo'), /has not allowed/);
    await assert.rejects(
      ask({ op: 'mcp', id, server: 'probe', tool: 'undeclared', arguments: {} }),
      /declares no MCP tool undeclared/,
    );
    await ask({ op: 'approve', id, digest: detail.digest });
    let started = Date.now();
    const echoed = await tool('echo', { text: 'hi "there" ñ' });
    const first = Date.now() - started;
    const said = JSON.parse(echoed.content[0].text);
    assert.deepEqual(said.args, { text: 'hi "there" ñ' });
    // The account's CLI starts the server in the screen's folder, once for every call.
    assert.equal(said.cwd.toLowerCase().replace(/\\/g, '/').split('/').at(-1), folder.toLowerCase().replace(/\\/g, '/').split('/').at(-1));
    started = Date.now();
    const again = JSON.parse((await tool('echo', { text: 'again' })).content[0].text);
    const second = Date.now() - started;
    assert.equal(again.pid, said.pid);
    const big = (await tool('big', { n: 1_000_000 })).content[0].text;
    assert(big.length === 1_000_000 && big.endsWith('END'));
    assert.deepEqual((await tool('structured')).structuredContent, { ok: true });
    await assert.rejects(tool('fail'), /It failed on purpose/);
    await assert.rejects(tool('nope'), /nope/);
    // The screen's page calls tools through the window that shows it. This driver wrote the
    // screen behind the app's back, and the tab reads a computer's list again 15 s after the last.
    const title = `Screens QA ${provider}`;
    const listed = (title) =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === title);
    for (let attempt = 0; !(await page.evaluate(listed, title)); attempt++) {
      assert(attempt < 30, `The Screens tab never listed ${title}`);
      for (const name of ['Active', 'Screens'])
        await page.evaluate(
          (name) =>
            [...document.querySelectorAll('[role="tab"]')]
              .find((tab) => tab.textContent.trim().startsWith(name))
              .click(),
          name,
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === title).click(),
      title,
    );
    let values;
    for (let attempt = 0; attempt < 120; attempt++) {
      values = (await ask({ op: 'load', id })).values;
      if (values.result) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.deepEqual(values.result?.structured, { ok: true }, JSON.stringify(values));
    assert.deepEqual(JSON.parse(values.result.text).args, { text: 'from the page' });
    assert.equal(JSON.parse(values.result.text).pid, said.pid);
    await page.cdp('Page.captureScreenshot').then(({ data }) =>
      writeFile(`${output}/${provider}-screen.png`, Buffer.from(data, 'base64')),
    );
    // Deleting the screen ends its CLI; a new screen of the account would start another.
    await ask({ op: 'delete', id });
    report.providers[provider] = {
      refusedBeforeApproval: true,
      firstCallMs: first,
      laterCallMs: second,
      oneServerProcess: true,
      wholeMegabyte: true,
      structured: true,
      toolError: true,
      pageCalls: true,
    };
  }
  assert.equal(await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''), '');
  await writeFile(`${output}/native-result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await page.button('Close window').catch(() => {});
} finally {
  page.close();
}
process.exit(0);
