// Opt-in real Codex replies in an isolated native app: a chat builds a static workflow with the
// workflow tools, runs it (its Agent step starts a chat of its own) and reads its result, then
// starts a mission whose orchestrator plans, spawns a worker and completes once the worker
// answers. Everything goes through this computer's own workflow store, as an unpaired desktop
// keeps it. Build with scripts/native-workflows.tauri.json (docs/WORKFLOWS.md). No credentials
// are copied; the chats work in disposable folders.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.workflows-qa';
const port = Number(process.env.WORKFLOWS_QA_PORT ?? 19851);
const executable = resolve(
  process.env.WORKFLOWS_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = 'artifacts/workflows-native';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

function launch() {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/start-windows.ps1',
      '-Executable',
      executable,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
async function connect() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(
        () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
      );
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}

// Codex app-servers this QA app runs: one per chat whose process is parked or replying.
function codexProcesses() {
  const list = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28 },
    ),
  );
  const app = list.find((p) => p.ExecutablePath?.toLowerCase() === executable.toLowerCase());
  assert(app, 'The QA app is not running');
  const children = new Map();
  for (const p of list)
    children.set(p.ParentProcessId, [...(children.get(p.ParentProcessId) ?? []), p]);
  let count = 0;
  const visit = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (/codex/i.test(child.CommandLine ?? '') && /app-server/.test(child.CommandLine ?? ''))
        count++;
      else visit(child.ProcessId);
    }
  };
  visit(app.ProcessId);
  return count;
}

launch();
const page = await connect();
await page.quitOnClose();
const report = { checkedAt: new Date().toISOString() };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
const noErrorBanner = async (when) => {
  await sleep(3000);
  const banner = await page.evaluate(
    () => document.querySelector('.error-banner')?.textContent?.trim() ?? '',
  );
  assert.equal(banner, '', `An error showed ${when}: ${banner}`);
};
try {
  // Workflow alerts would show real toasts for this identity.
  await page.invoke('set_desktop_notifications', { enabled: false, sound: false });
  const identity = await page.invoke('get_installation');
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Workflows QA')),
    'Use only a disposable Workflows QA workspace.',
  );
  let connectionId = workspace.fleet.connections.find(
    (c) =>
      c.environmentId === identity.id &&
      c.profile === 'existing' &&
      workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === 'codex',
  )?.id;
  if (!connectionId) {
    const account = { id: crypto.randomUUID(), provider: 'codex', name: 'Workflows QA codex' };
    const created = {
      id: crypto.randomUUID(),
      accountId: account.id,
      environmentId: identity.id,
      profile: 'existing',
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(created);
    connectionId = created.id;
  }
  const now = new Date().toISOString();
  const driver = {
    id: crypto.randomUUID(),
    title: `Workflows QA driver ${Date.now()}`,
  };
  workspace.conversations.push({
    id: driver.id,
    title: driver.title,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'codex', model: '', reasoning: 'low', instructions: '', connectionId },
    location: {
      computerId: identity.computerId,
      environmentId: identity.id,
      path: await mkdtemp(join(tmpdir(), 'studio-workflows-driver-')),
    },
    messages: [],
  });
  // The Workflows row's list, unfolded (as an earlier run may have left it), takes the chat
  // lists' place: fold it to reach the chats.
  const showChats = () =>
    page.evaluate(() => {
      const row = document.querySelector('.workflows-row .sidebar-nav-row');
      if (row?.getAttribute('aria-expanded') === 'true') row.click();
    });
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded app lists the chat.
  const listed = () =>
    page.evaluate(async (title) => {
      const row = document.querySelector('.workflows-row .sidebar-nav-row');
      if (row?.getAttribute('aria-expanded') === 'true') row.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector('#conversation-tab-history')?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [...document.querySelectorAll('.conversation-item')].some((e) => e.title === title);
    }, driver.title);
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    for (const key of ['accounts', 'connections'])
      for (const item of workspace.fleet[key])
        if (!current.fleet[key].some((i) => i.id === item.id)) current.fleet[key].push(item);
    for (const conversation of workspace.conversations)
      if (!current.conversations.some((c) => c.id === conversation.id))
        current.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.workflowsReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.workflowsReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    if (await listed()) break;
    assert(attempt < 5, 'The seeded chat did not survive the app reload');
    await sleep(2000);
  }
  await noErrorBanner('after the start');
  const status = await page.invoke('detect_connection', { provider: 'codex', connectionId });
  assert.equal(status.auth, 'ready', 'Codex must be signed in');

  const openChat = async (title) => {
    await showChats();
    for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
      await page.click(tab);
      const found = await page.evaluate((title) => {
        const row = [...document.querySelectorAll('.conversation-item')].find(
          (e) => e.title === title,
        );
        row?.click();
        return !!row;
      }, title);
      if (found) break;
    }
    await page.waitFor(
      (title) => document.querySelector('.conversation-item[aria-current="page"]')?.title === title,
      title,
    );
  };
  const text = (message) => message.blocks.map((b) => b.text ?? '').join('\n');
  const conversation = async (id) =>
    (await page.invoke('load_workspace')).conversations.find((c) => c.id === id);
  // Sends a message to the driver chat and waits for its reply to end.
  const ask = async (prompt, timeout = 300_000) => {
    await openChat(driver.title);
    const before = (await conversation(driver.id)).messages.length;
    await page.evaluate((prompt) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    const deadline = Date.now() + timeout;
    for (;;) {
      const messages = (await conversation(driver.id)).messages;
      const reply = messages.slice(before).findLast((m) => m.role === 'assistant');
      if (reply && reply.status !== 'running') {
        assert.equal(reply.status, 'complete', reply.error);
        return reply;
      }
      assert(Date.now() < deadline, 'The driver reply timed out');
      await sleep(1000);
    }
  };
  // This computer's workflow store, read as the page reads it, without what earlier runs of
  // this driver left there.
  const stored = async () => {
    const names = await page.invoke('workflow_file_names');
    const found = [];
    for (const name of names.filter((n) => /^doc-.*\.json$/.test(n))) {
      const json = await page.invoke('workflow_file_read', { name });
      if (json) found.push(JSON.parse(json));
    }
    return found;
  };
  const earlier = new Set((await stored()).map((d) => d.id));
  const docs = async () => (await stored()).filter((d) => !earlier.has(d.id));
  const events = async (id) => {
    const names = await page.invoke('workflow_file_names');
    const found = [];
    for (const name of names.filter((n) => n.startsWith(`events-${id}-`)).sort()) {
      const json = await page.invoke('workflow_file_read', { name });
      if (json) found.push(...JSON.parse(json));
    }
    return found;
  };
  const settledRun = async (match, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const run = (await docs()).find((d) => d.kind === 'run' && match(d.body));
      if (run && !['running', 'paused'].includes(run.body.status)) return run;
      assert(Date.now() < deadline, `The run did not end: ${run?.body.detail ?? 'not found'}`);
      await sleep(2000);
    }
  };
  // The sidebar lists the workflows under its Workflows row: a static workflow opens on its
  // graph, a dynamic one in its orchestrator's chat with the graph beside it.
  const openWorkflow = async (title) => {
    await page.evaluate(() => {
      const row = document.querySelector('.workflows-row .sidebar-nav-row');
      if (row?.getAttribute('aria-expanded') !== 'true') row?.click();
    });
    await page.waitFor(
      (title) =>
        [...document.querySelectorAll('.workflow-item')].some((item) => item.title === title),
      title,
    );
    await page.evaluate((title) => {
      [...document.querySelectorAll('.workflow-item')].find((item) => item.title === title).click();
    }, title);
    await page.waitFor(() => document.querySelectorAll('.workflow-card').length > 0);
    await sleep(800);
  };

  // 1. A chat builds a static workflow with an Agent step and runs it.
  const greeting = 'Workflows QA greeting';
  const built = await ask(
    `This is an Agent Studio QA test. Use only the workflow tools and run no shell command. First call workflow_save to create a workflow named "${greeting}" with three nodes: a start step (key start) with one input named topic; an agent step (key greet, title Greet) with config provider codex, reasoning low and the prompt "This is a QA test. Do not use any tools. Reply exactly: GREETING {{input.topic}}"; and an end step (key finish) whose config output is "{{greet.output}}". Connect start's out port to greet and greet's out port to finish. Then call workflow_run once for it with the input topic set to NATIVE. Do not wait for the run. Reply with one line: RUN followed by the run's id.`,
  );
  report.built = text(built).trim();
  const definition = (await docs()).find(
    (d) => d.kind === 'definition' && d.body.name === greeting,
  );
  assert(definition, 'workflow_save saved no definition');
  report.definition = {
    nodes: definition.body.graph.nodes.map((n) => `${n.key}:${n.type}`),
    edges: definition.body.graph.edges.length,
  };
  assert.deepEqual([...report.definition.nodes].sort(), [
    'finish:end',
    'greet:agent',
    'start:start',
  ]);
  const run = await settledRun((body) => body.definition?.id === definition.id, 300_000);
  report.staticRun = {
    status: run.body.status,
    output: run.body.output,
    agents: run.body.agents.map((a) => ({ role: a.role, status: a.status })),
  };
  assert.equal(run.body.status, 'completed', run.body.detail);
  assert.match(String(run.body.output), /GREETING NATIVE/);
  assert.deepEqual(report.staticRun.agents, [{ role: 'step', status: 'done' }]);
  assert(report.built.includes(run.id), `The reply named another run: ${report.built}`);
  // The Agent step's chat replied and stays out of the chat lists.
  const stepChat = await conversation(run.body.agents[0].conversationId);
  assert.match(text(stepChat.messages.findLast((m) => m.role === 'assistant')), /GREETING NATIVE/);
  await showChats();
  const rows = await page.evaluate(async () => {
    const titles = [];
    for (const tab of ['#conversation-tab-active', '#conversation-tab-history']) {
      document.querySelector(tab)?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      titles.push(...[...document.querySelectorAll('.conversation-item')].map((e) => e.title));
    }
    return titles;
  });
  assert(!rows.includes(stepChat.title), 'The Agent step chat is listed');
  report.staticHistory = (await events(run.id)).map((e) => e.kind);
  await openWorkflow(greeting);
  report.definitionCards = await page.evaluate(
    () => document.querySelectorAll('.workflow-card').length,
  );
  assert.equal(report.definitionCards, 3);
  await capture('definition');
  await noErrorBanner('in the workflow editor');

  // 2. The chat reads the run back with workflow_status.
  const status2 = await ask(
    `Call workflow_status once for the run ${run.id}, use no other tool, and reply with one line: its status, then its output.`,
  );
  report.statusReply = text(status2).trim();
  assert.match(report.statusReply, /completed/i);
  assert.match(report.statusReply, /GREETING NATIVE/);

  // 3. A mission: its orchestrator plans, spawns a worker and completes after its answer.
  const missionTitle = 'Workflows QA mission';
  const started = await ask(
    `Call dynamic_start once, with title "${missionTitle}", orchestrator {"provider": "codex", "reasoning": "low"} and this goal: "This is an Agent Studio QA test of dynamic workflows; keep it minimal. Add one task to the plan with dynamic_plan. Then spawn exactly one agent with dynamic_spawn (agent provider codex, reasoning low, taskId the task's id) whose task is: Do not use any tools. Reply exactly: WORKER DONE. End your turn after spawning it. When you hear that the agent finished, mark the task done with dynamic_plan and call dynamic_complete with the summary QA mission complete." Use no other tool and reply with one line: MISSION followed by the mission's id.`,
  );
  report.started = text(started).trim();
  const findMission = async () =>
    (await docs()).find((d) => d.kind === 'run' && d.body.mode === 'dynamic');
  const deadline = Date.now() + 120_000;
  let mission;
  while (!(mission = await findMission())) {
    assert(Date.now() < deadline, 'dynamic_start saved no mission');
    await sleep(1000);
  }
  assert(report.started.includes(mission.id), `The reply named another mission: ${report.started}`);
  await openWorkflow(mission.body.title);
  // The graph while the mission works: its orchestrator, then its plan and worker.
  const graphDeadline = Date.now() + 300_000;
  for (;;) {
    const cards = await page.evaluate(() => document.querySelectorAll('.workflow-card').length);
    const current = await findMission();
    if (cards >= 2 && current.body.agents.some((a) => a.role === 'worker')) break;
    if (!['running', 'paused'].includes(current.body.status)) break;
    assert(Date.now() < graphDeadline, 'The mission spawned no worker');
    await sleep(1000);
  }
  await capture('mission-running');
  const ended = await settledRun((body) => body.mode === 'dynamic', 600_000);
  report.mission = {
    status: ended.body.status,
    output: ended.body.output,
    tasks: ended.body.tasks.map((t) => ({ title: t.title, status: t.status })),
    agents: ended.body.agents.map((a) => ({ role: a.role, status: a.status })),
    sessions: ended.body.sessions.length,
  };
  assert.equal(ended.body.status, 'completed', ended.body.detail);
  assert(
    ended.body.agents.every((a) => a.status === 'done'),
    'An agent still reads as running',
  );
  const worker = ended.body.agents.find((a) => a.role === 'worker');
  assert(worker, 'The mission had no worker');
  assert.equal(worker.status, 'done');
  const workerChat = await conversation(worker.conversationId);
  assert.match(text(workerChat.messages.findLast((m) => m.role === 'assistant')), /WORKER DONE/);
  report.missionHistory = (await events(ended.id)).map((e) => e.kind);
  // The chats the workflows started give back their CLI processes once their replies end,
  // the orchestrator's after the reply that completed the mission: only the driver chat's stays.
  const processDeadline = Date.now() + 60_000;
  for (;;) {
    report.parkedCodex = codexProcesses();
    if (report.parkedCodex <= 1) break;
    assert(Date.now() < processDeadline, `${report.parkedCodex} Codex processes stayed`);
    await sleep(2000);
  }
  await sleep(2500);
  await capture('mission-completed');
  report.missionCards = await page.evaluate(
    () => document.querySelectorAll('.workflow-card').length,
  );
  await noErrorBanner('in the mission view');
  // Its plan settled, its history lists what happened, and its worker's chat is the
  // workflow's: read there, without a composer.
  assert(
    ended.body.tasks.every((t) => t.status === 'done'),
    `A task did not settle: ${JSON.stringify(report.mission.tasks)}`,
  );
  // The history opens from History in the run's header.
  await page.evaluate(() => {
    const button = document.querySelector('.workflow-main button[aria-label="History"]');
    if (button?.getAttribute('aria-pressed') !== 'true') button?.click();
  });
  await page.waitFor(() => document.querySelectorAll('.run-sheet .entry').length > 0);
  report.historyEntries = await page.evaluate(
    () => document.querySelectorAll('.run-sheet .entry').length,
  );
  assert(report.historyEntries >= 4, `The history shows ${report.historyEntries} entries`);
  await page.evaluate(() =>
    [...document.querySelectorAll('.workflow-card button')]
      .find((b) => /^Open the chat of /.test(b.getAttribute('aria-label') ?? ''))
      ?.click(),
  );
  await page.waitFor(() => !!document.querySelector('.workflow-owned'));
  report.workerReadOnly = await page.evaluate(
    () => !document.querySelector('[aria-label="Message"]'),
  );
  assert(report.workerReadOnly, 'The worker chat offers a composer');
  // It opened in the chat card beside the graph, with the way back to the orchestrator.
  report.workerBeside = await page.evaluate(() => ({
    graph: !!document.querySelector('.workflow-main .workflow-card'),
    back: document.querySelector('.workflow-owned .back')?.textContent.trim(),
  }));
  assert.deepEqual(report.workerBeside, { graph: true, back: 'Orchestrator' });
  // The graph fits itself to the narrower canvas a moment after the card opens.
  await sleep(800);
  await capture('worker-read-only');
  await noErrorBanner('in the worker chat');
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await capture('failure').catch(() => {});
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  await page.button('Close window').catch(() => {});
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
