// Opt-in native composer/provider checks. Only touches this isolated QA workspace.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
import { checkNativeArtifact } from './artifact-native-check.mjs';
const page = await nativePage(9487);
const report = {
  ...JSON.parse(
    await readFile('artifacts/work-features-native-result.json', 'utf8').catch(() => '{}'),
  ),
  checkedAt: new Date().toISOString(),
};
async function reload() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => (window.qaDocument = marker), marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.qaDocument !== marker &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    marker,
  );
}
async function openChat(title) {
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((el) => el.textContent.includes('History'))
      .click(),
  );
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((el) =>
        el.textContent.includes(title),
      ),
    title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((el) => el.textContent.includes(title))
        .click(),
    title,
  );
}
async function finish(id) {
  const deadline = Date.now() + 610000;
  while (Date.now() < deadline) {
    const w = await page.invoke('load_workspace');
    const reply = w.conversations.find((c) => c.id === id)?.messages.at(-1);
    if (reply?.role === 'assistant' && reply.status !== 'running') {
      assert.equal(reply.status, 'complete', reply.error);
      return reply;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Native provider did not complete');
}
async function screenshot(name) {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/${name}.png`, Buffer.from(shot.data, 'base64'));
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.work-features-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  let workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Work Features QA')),
    'Not a disposable QA workspace',
  );
  const folder = await mkdtemp(join(tmpdir(), 'studio-work-features-'));
  const marker = crypto.randomUUID();
  await writeFile(join(folder, 'marker.txt'), marker);
  const workflow = {
    id: crypto.randomUUID(),
    name: 'Native workflow check',
    steps: [
      {
        title: 'Read fixture',
        prompt: `Task tracking is the feature under test. First call ToolSearch with query select:TaskCreate,TaskUpdate; then actually call TaskCreate and TaskUpdate to track reading marker.txt in ${folder} and returning its value. Update the plan as you work, marking tasks complete only after doing them. Read only that fixture file, using Read. Return its exact marker. No web search, integrations, subagents, or file edits.`,
      },
      {
        title: 'Build counter',
        prompt:
          'Use the previous step result without reading any files: repeat its exact marker in your answer. Task tracking is the feature under test. First call ToolSearch with query select:TaskCreate,TaskUpdate, then actually invoke TaskCreate and TaskUpdate to track creating and returning one tiny self-contained HTML counter. Actual task-tool calls are required; a text checklist is insufficient. Deliver a fenced html code block titled Native Counter. Use heading "Native Counter", a button "Add one", and output with id count initially 0. Inline JavaScript increments the output. No external resources, file edits, searches, or subagents. Mark the plan complete once you have prepared the source.',
      },
    ],
  };
  workspace.workflows = [workflow];
  const chats = [];
  for (const provider of (process.env.QA_PROVIDERS ?? 'claude,codex').split(',')) {
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `Missing existing ${provider} connection`);
    const state = await page.invoke('detect_connection', { provider, connectionId: connection.id });
    assert.equal(state.auth, 'ready', `${provider}: ${state.detail}`);
    const id = crypto.randomUUID(),
      title = `Work Features QA ${provider} ${id.slice(0, 8)}`,
      now = new Date().toISOString();
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      settings: {
        provider,
        model: provider === 'claude' ? 'sonnet' : (process.env.QA_CODEX_MODEL ?? 'gpt-5.6-sol'),
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    chats.push({ id, title, provider });
  }
  await page.invoke('save_workspace', { workspace });
  await reload();
  for (const chat of chats) {
    await openChat(chat.title);
    if (chat.provider === 'claude') {
      await page.button('Claude workflows');
      await page.click('[aria-label="Saved workflow"]');
      await page.evaluate(() =>
        [...document.querySelectorAll('[role="option"]')]
          .find((el) => el.textContent.includes('Native workflow check'))
          .click(),
      );
      await page.waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (el) => el.textContent.trim() === 'Run workflow' && !el.disabled,
        ),
      );
      await page.button('Run workflow');
    } else {
      await page.evaluate((folder) => {
        const el = document.querySelector('[aria-label="Message"]');
        el.value = `The studio_update_plan tool is the feature under test. Actually call studio_update_plan to track two steps: read marker.txt from ${folder}, then return the marker. Actual tool calls are required; a Markdown checklist is insufficient. Mark each step complete after doing it. If studio_update_plan is unavailable, state that explicitly. Read no other files, make no edits, do not search the web or delegate. Return the marker and a short final answer.`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, folder);
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.button('Send message');
    }
    console.log(`Native ${chat.provider}: waiting for actual provider completion`);
    const reply = await finish(chat.id);
    const answer = reply.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('\n');
    assert(answer.includes(marker), 'Fixture marker missing');
    assert(reply.plan?.steps.length, `${chat.provider}: no provider plan decoded`);
    if (chat.provider === 'claude') {
      assert.equal(reply.workflow.steps.filter((s) => s.status === 'complete').length, 2);
      assert(answer.split(marker).length >= 3, 'Second step did not carry the first result');
      assert.equal(reply.workflowDefinition.id, workflow.id);
      await page.waitFor(() => !!document.querySelector('.response-artifacts button'));
    }
    report[chat.provider] = {
      conversationId: chat.id,
      markerVerified: true,
      status: reply.status,
      plan: reply.plan,
      workflow: reply.workflow,
      usage: reply.usage,
    };
    await page.evaluate(() => {
      document.querySelector('.message .plan-panel').open = true;
      document
        .querySelector('.message .plan-panel')
        .scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await screenshot(`work-features-${chat.provider}-native`);
    await reload();
    await openChat(chat.title);
    await page.waitFor(() => !!document.querySelector('.message .plan-panel'));
    report[chat.provider].reloadVerified = true;
    await writeFile('artifacts/work-features-native-result.json', JSON.stringify(report, null, 2));
    console.log(`Native ${chat.provider}: plan and saved history verified`);
  }
  const claudeChat = (await page.invoke('load_workspace')).conversations.find(
    (c) => c.id === report.claude?.conversationId,
  );
  assert(claudeChat, 'Run the Claude check first');
  await openChat(claudeChat.title);
  await page.click('.response-artifacts button');
  await page.waitFor(() => !!document.querySelector('.artifact-viewer iframe'));
  report.artifact = await checkNativeArtifact(9487);
  await screenshot('artifact-preview-native');
  // Validate native download bytes, using the same app command as the viewer.
  const source = '<!doctype html><h1>Native download fixture</h1>';
  const saved = await page.invoke('save_artifact', {
    source,
    filename: 'native-qa.html',
    language: 'html',
  });
  assert.equal(await readFile(saved, 'utf8'), source);
  report.download = { verified: true, path: saved };
  report.rendererErrors = page.errors;
  await writeFile('artifacts/work-features-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
