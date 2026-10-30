// Screens in the native app (docs/SCREENS.md), against the installed CLIs. Each provider gets an
// isolated account whose profile receives a local stdio probe server through MCP management; a
// screen of that account calls the probe's tools, declared or not, at once, through manage_screen
// and from the screen's own page. A PowerShell action runs as a job whose output arrives as it
// prints, which a stop ends; a screen's page stays loaded while Settings shows. When this
// computer has a WSL distribution, a bash command runs there, and the distribution's MCP servers
// are listed as a Windows screen reaches them (with SCREENS_QA_WSL_CALL=server/tool, that tool is
// called there). Build and launch scripts/native-screens-mcp.tauri.json first (CDP 19891).
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
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
// A page that calls two tools as it opens, one it does not declare, and keeps what it received.
const html = `<p id="out">Calling…</p><script>
(async () => {
  try {
    const echoed = await studio.mcp('probe', 'echo', { text: 'from the page' });
    const structured = await studio.mcpJson('probe', 'structured', {});
    await studio.save('result', { text: echoed.text, structured, account: echoed.account });
    document.getElementById('out').textContent = 'Done';
  } catch (error) {
    await studio.save('result', { error: error.message });
  }
})();
</script>`;
// A page that notes each time it loads and follows a job of its own as it prints.
const kept = `<p id="out">Loaded</p><script>
(async () => {
  const loads = (studio.values.loads || []).concat(Math.random());
  await studio.save('loads', loads);
  let printed = '';
  const result = await studio.run('count', {}, { onOutput: (text) => (printed += text) });
  await studio.save('followed', { printed, exitCode: result.exitCode, chunks: printed.split('step').length - 1 });
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
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );
  const identity = await page.invoke('get_installation');
  // Its long path, which WSL reaches under /mnt.
  const folder = realpathSync.native(await mkdtemp(join(tmpdir(), 'studio-screens-mcp-')));
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
  /** Writes a screen behind the app's back, as a chat of this computer would have saved it. */
  const writeScreen = async (fields) => {
    const id = crypto.randomUUID();
    const time = new Date().toISOString();
    await writeFile(
      join(screens, `${id}.json`),
      JSON.stringify({
        id,
        revision: 1,
        description: '',
        actions: [],
        site: { environmentId: identity.id, folder, project: folder },
        conversationId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        createdAt: time,
        updatedAt: time,
        ...fields,
      }),
    );
    return id;
  };
  /** Opens a screen from the Screens tab, which reads the list again 15 s after the last. */
  const openScreen = async (title) => {
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
        [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === title)
          .click(),
      title,
    );
  };
  const valueOf = async (id, key, attempts = 240) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const values = (await ask({ op: 'load', id })).values;
      if (values[key] !== undefined) return values[key];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  };

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
    const title = `Screens QA ${provider}`;
    const id = await writeScreen({
      title,
      html,
      mcpTools: ['echo', 'fail', 'structured', 'nope'].map((tool) => ({ server: 'probe', tool })),
      account: { provider, connectionId },
    });
    const detail = await ask({ op: 'read', id });
    assert.equal(detail.allowed, true);
    assert.equal(detail.tools, 4);
    assert.deepEqual(detail.account, { provider, connectionId });
    const tool = (name, args = {}) =>
      ask({ op: 'mcp', id, server: 'probe', tool: name, arguments: args });
    // Nothing waits for an approval.
    let started = Date.now();
    const echoed = await tool('echo', { text: 'hi "there" ñ' });
    const first = Date.now() - started;
    const said = JSON.parse(echoed.content[0].text);
    assert.deepEqual(said.args, { text: 'hi "there" ñ' });
    assert.equal(
      echoed.account,
      `Screens QA ${provider} (${provider === 'claude' ? 'Claude' : 'Codex'})`,
    );
    // The account's CLI starts the server in the screen's folder, once for every call.
    assert.equal(
      said.cwd.toLowerCase().replace(/\\/g, '/').split('/').at(-1),
      folder.toLowerCase().replace(/\\/g, '/').split('/').at(-1),
    );
    started = Date.now();
    const again = JSON.parse((await tool('echo', { text: 'again' })).content[0].text);
    const second = Date.now() - started;
    assert.equal(again.pid, said.pid);
    // A tool the screen does not declare answers too.
    const big = (await tool('big', { n: 1_000_000 })).content[0].text;
    assert(big.length === 1_000_000 && big.endsWith('END'));
    assert.deepEqual((await tool('structured')).structuredContent, { ok: true });
    await assert.rejects(tool('fail'), /It failed on purpose/);
    await assert.rejects(tool('nope'), /nope/);
    // The listing names the probe and its tools.
    const listing = await ask({ op: 'tools', id });
    const listed = listing.servers.find((server) => server.name === 'probe');
    assert(listed && listed.tools.some((t) => t.name === 'echo'), JSON.stringify(listing));
    // The screen's page calls tools through the window that shows it.
    await openScreen(title);
    const result = await valueOf(id, 'result');
    assert.deepEqual(result?.structured, { ok: true }, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.text).args, { text: 'from the page' });
    assert.equal(JSON.parse(result.text).pid, said.pid);
    await page
      .cdp('Page.captureScreenshot')
      .then(({ data }) =>
        writeFile(`${output}/${provider}-screen.png`, Buffer.from(data, 'base64')),
      );
    // Deleting the screen ends its CLI.
    await ask({ op: 'delete', id });
    report.providers[provider] = {
      atOnce: true,
      firstCallMs: first,
      laterCallMs: second,
      oneServerProcess: true,
      undeclaredTool: true,
      wholeMegabyte: true,
      structured: true,
      toolError: true,
      listing: listed.tools.length,
      pageCalls: true,
    };
  }

  // Jobs: output as it prints, kept until forgotten, stopped with what they started.
  const count = {
    name: 'count',
    shell: 'powershell',
    script:
      'foreach ($step in 1..5) { Write-Output "step $step"; Start-Sleep -Milliseconds 400 }\nexit 3',
  };
  const slow = {
    name: 'slow',
    shell: 'powershell',
    script: "Write-Output 'started'\nStart-Sleep -Seconds 120",
  };
  const jobsId = await writeScreen({
    title: 'Screens QA jobs',
    html: kept,
    actions: [count, slow],
  });
  const job = await ask({ op: 'start', id: jobsId, action: 'count', keep: true });
  assert.equal(job.state, 'running');
  let after = 0;
  let printed = '';
  let answers = 0;
  let ended;
  for (;;) {
    const answer = await ask({ op: 'output', id: jobsId, job: job.id, after, wait: true });
    if (answer.chunks.length) answers++;
    printed += answer.chunks.map((chunk) => chunk.text).join('');
    after = answer.next;
    if (answer.job.state !== 'running') {
      ended = answer.job;
      break;
    }
  }
  assert.equal(ended.state, 'done');
  assert.equal(ended.exitCode, 3);
  assert.match(printed, /step 1[\s\S]*step 5/);
  assert(answers >= 3, `Output arrived in ${answers} answers`);
  assert((await ask({ op: 'jobs', id: jobsId })).jobs.some((known) => known.id === job.id));
  await ask({ op: 'forget', id: jobsId, job: job.id });
  const long = await ask({ op: 'start', id: jobsId, action: 'slow', keep: true });
  const first = await ask({ op: 'output', id: jobsId, job: long.id, after: 0, wait: true });
  assert.match(first.chunks.map((chunk) => chunk.text).join(''), /started/);
  const stopAt = Date.now();
  const stopped = await ask({ op: 'stop', id: jobsId, job: long.id });
  assert.equal(stopped.state, 'stopped');
  report.jobs = { answers, exitCode: ended.exitCode, stopMs: Date.now() - stopAt };

  // A screen's page stays loaded while Settings shows, and Reload loads it again.
  await openScreen('Screens QA jobs');
  const followed = await valueOf(jobsId, 'followed');
  assert.equal(followed?.exitCode, 3, JSON.stringify(followed));
  assert.equal((await valueOf(jobsId, 'loads')).length, 1);
  await page.button('Settings');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await openScreen('Screens QA jobs');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal((await valueOf(jobsId, 'loads')).length, 1, 'The page loaded again');
  // Every screen this window opened is mounted; the one shown is not hidden.
  await page.click('.screen-kept:not([hidden]) [aria-label="Reload this screen"]');
  for (let attempt = 0; (await valueOf(jobsId, 'loads')).length < 2; attempt++) {
    assert(attempt < 60, 'Reload did not load the page again');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  report.keptPage = { loadsBeforeReload: 1, loadsAfterReload: 2, streamedChunks: followed.chunks };
  await page
    .cdp('Page.captureScreenshot')
    .then(({ data }) => writeFile(`${output}/jobs-screen.png`, Buffer.from(data, 'base64')));

  // WSL: a bash command there, and the distribution's servers as a Windows screen reaches them.
  const fleet = (await page.invoke('load_workspace')).fleet;
  const wsl = fleet.environments.find(
    (environment) => environment.platform === 'wsl' && environment.discoveredOn === identity.id,
  );
  if (wsl) {
    const where = await ask({
      op: 'start',
      id: jobsId,
      command: { shell: 'bash', script: 'printf "%s|%s" "$(uname -s)" "$PWD"', where: 'wsl' },
    });
    let text = '';
    for (let after = 0; ;) {
      const answer = await ask({ op: 'output', id: jobsId, job: where.id, after, wait: true });
      text += answer.chunks.map((chunk) => chunk.text).join('');
      after = answer.next;
      if (answer.job.state !== 'running') break;
    }
    assert.match(text, /^Linux\|\/mnt\//, text);
    let servers;
    try {
      servers = await ask({ op: 'tools', id: jobsId, where: 'wsl' });
    } catch (error) {
      servers = { error: String(error) };
    }
    report.wsl = {
      distribution: wsl.distribution,
      command: text,
      account: servers.account,
      servers: servers.servers?.map(
        (server) => `${server.name} ${server.status} ${server.tools.length}`,
      ),
      error: servers.error,
    };
    const named = process.env.SCREENS_QA_WSL_CALL;
    if (named) {
      const [server, tool] = named.split('/');
      const answer = await ask({
        op: 'mcp',
        id: jobsId,
        server,
        tool,
        arguments: {},
        where: 'wsl',
      });
      report.wsl.call = {
        tool: named,
        account: answer.account,
        bytes: JSON.stringify(answer).length,
      };
    }
  }
  await ask({ op: 'delete', id: jobsId });
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );
  await writeFile(`${output}/native-result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await page.button('Close window').catch(() => {});
} finally {
  page.close();
}
process.exit(0);
