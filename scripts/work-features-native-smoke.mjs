// Opt-in native composer/provider checks. Only touches this isolated QA workspace.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
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
  const workflowDirectory = join(folder, '.claude', 'workflows');
  await mkdir(workflowDirectory, { recursive: true });
  const nativeScript =
    'export const meta = { name: "studio-native-check", description: "Read one fixture", phases: ["Read fixture"] }; phase("Read fixture"); return await agent(' +
    JSON.stringify(
      'Read only ' +
        join(folder, 'marker.txt') +
        ' and return its exact content. Use no other tools, files, integrations, or web access.',
    ) +
    ', {label:"Fixture reader"});';
  await writeFile(join(workflowDirectory, 'studio-native-check.js'), nativeScript);
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
      await page.evaluate((folder) => {
        const el = document.querySelector('[aria-label="Message"]');
        el.value =
          'Run the saved native /studio-native-check workflow through the Workflow tool. Wait for the result. Then use TaskCreate and TaskUpdate to track returning that marker with a tiny self-contained HTML counter in a fenced html block titled Native Counter, heading Native Counter, button Add one, output id count initially 0 and inline JavaScript increments it. Actually use those task tools. Finally save this native workflow for reuse as /studio-native-saved in ' +
          folder +
          '/.claude/workflows/studio-native-saved.js (copy the original script, changing only meta.name). Do not use a custom prompt sequence. Read only the fixture and these workflow scripts; no external files, web, or integrations.';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, folder);
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.button('Send message');
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
      assert.equal(reply.nativeWorkflows?.runs[0]?.name, 'studio-native-check');
      assert.equal(reply.nativeWorkflows.runs[0].status, 'complete');
      assert.equal(reply.nativeWorkflows.runs[0].agents[0].status, 'complete');
      assert(reply.nativeWorkflows.runs[0].agents[0].result.includes(marker));
      assert(
        (await readFile(join(workflowDirectory, 'studio-native-saved.js'), 'utf8')).includes(
          'studio-native-saved',
        ),
      );
      await page.waitFor(() => !!document.querySelector('.response-artifacts button'));
    }
    report[chat.provider] = {
      conversationId: chat.id,
      markerVerified: true,
      status: reply.status,
      plan: reply.plan,
      nativeWorkflows: reply.nativeWorkflows,
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
    if (chat.provider === 'claude') {
      await page.evaluate(() => {
        const el = document.querySelector('[aria-label="Message"]');
        el.value =
          'Run /studio-native-saved with the native Workflow tool, wait for completion, and return the exact fixture marker. No changes or other work.';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.button('Send message');
      const reused = await finish(chat.id);
      assert.equal(reused.nativeWorkflows?.runs[0]?.name, 'studio-native-saved');
      assert.equal(reused.nativeWorkflows.runs[0].status, 'complete');
      assert(reused.blocks.some((b) => b.type === 'markdown' && b.text.includes(marker)));
      report.claude.nativeSaveAndReuseVerified = true;
    }
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
