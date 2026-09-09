// Opt-in: actual UI -> IPC -> provider -> rendered/saved activity in an isolated QA identity.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9457);
async function reloadReady() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => {
    window.capabilityPageMarker = marker;
  }, marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.capabilityPageMarker !== marker &&
      !!document.querySelector('[aria-label="New conversation"]') &&
      !document.querySelector('[aria-label="New conversation"]').disabled &&
      [...document.querySelectorAll('[role="tab"]')].some((el) =>
        el.textContent.includes('History'),
      ),
    marker,
  );
}
const report = { checkedAt: new Date().toISOString(), providers: {} };
if (process.env.QA_PROVIDER) {
  try {
    report.providers = JSON.parse(
      await readFile('artifacts/capabilities-native-result.json', 'utf8'),
    ).providers;
  } catch {
    /* First provider run. */
  }
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.capabilities-qa',
  );
  await page.waitFor(() => !!document.querySelector('[aria-label="New conversation"]'));
  const identity = await page.invoke('get_installation');
  let workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Capability QA')),
    'This is not a disposable capabilities workspace.',
  );
  for (const [provider, model] of [
    ['claude', 'sonnet'],
    ['codex', 'gpt-5.6-sol'],
  ]) {
    if (process.env.QA_PROVIDER && process.env.QA_PROVIDER !== provider) continue;
    const folder = await mkdtemp(join(tmpdir(), 'studio-native-capabilities-'));
    const marker = crypto.randomUUID(),
      skillMarker = crypto.randomUUID();
    await writeFile(join(folder, 'marker.txt'), marker);
    await writeFile(
      join(folder, 'README.txt'),
      'A disposable fixture for tool activity presentation.\n',
    );
    for (const prefix of ['.claude', '.agents']) {
      const dir = join(folder, prefix, 'skills', 'capability-check');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: capability-check\ndescription: Verify Agent Studio capability rendering in a disposable fixture.\n---\nInclude the exact skill marker ${skillMarker} in your final answer.\n`,
      );
    }
    workspace = await page.invoke('load_workspace');
    let account = workspace.fleet.accounts.find((a) => a.provider === provider);
    if (!account) {
      account = { id: crypto.randomUUID(), name: `${provider} QA`, provider, purpose: 'personal' };
      workspace.fleet.accounts.push(account);
    }
    let connection = workspace.fleet.connections.find(
      (c) => c.accountId === account.id && c.environmentId === identity.id,
    );
    if (!connection) {
      connection = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      };
      workspace.fleet.connections.push(connection);
    }
    const id = crypto.randomUUID();
    const title = `Capability QA ${provider} ${id.slice(0, 8)}`;
    const now = new Date().toISOString();
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      settings: {
        connectionId: connection.id,
        provider,
        model,
        reasoning: 'low',
        instructions: '',
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    await page.invoke('save_workspace', { workspace });
    await reloadReady();
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
    const prompt = `Disposable integration test in ${folder}: first give a short progress update. Read README.txt and find *.txt files in this fixture (use Read and Glob if available). Use the capability-check skill in this folder (invoke Skill if available, otherwise read its SKILL.md). Search the web once with the built-in search tool for IANA example domains reserved for documentation; cite one source URL. Spawn exactly one sub-agent with task_name fixture_reader (use an underscore in the name) using the built-in delegation tool and ask it to read the absolute file ${join(folder, 'marker.txt')} and return the value. Do not read marker.txt yourself. Wait for the child to finish. Do not inspect outside this fixture, use integrations, or edit files. Final answer: the skill marker, child marker, and source URL.`;
    await page.evaluate((prompt) => {
      const el = document.querySelector('[aria-label="Message"]');
      el.value = prompt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await page.waitFor(() => !document.querySelector('[aria-label="Send message"]')?.disabled);
    await page.click('[aria-label="Send message"]');
    console.log(`Checking ${provider} through the native composer...`);
    const deadline = Date.now() + 310000;
    let reply;
    while (Date.now() < deadline) {
      workspace = await page.invoke('load_workspace');
      reply = workspace.conversations.find((c) => c.id === id)?.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(reply?.status, 'complete', reply?.error ?? `${provider} reply did not complete`);
    const answer = reply.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('\n');
    const tools = reply.blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : []));
    const progress = reply.blocks.filter((b) => b.type === 'activity' && b.progress);
    assert(progress.length > 0, 'Missing inline progress transcript.');
    assert(
      tools.some(
        (t) =>
          t.operation === 'read' &&
          (t.path?.includes('README.txt') ||
            t.facts?.some((f) => f.label === 'Also read' && f.value.includes('README.txt'))),
      ),
      'Missing ordinary read target.',
    );
    if (provider === 'claude') {
      assert(
        tools.some((t) => t.operation === 'glob' && t.query?.includes('*.txt')),
        'Missing file pattern.',
      );
      assert(
        tools.some((t) => t.operation === 'toolSearch' && t.query),
        'Missing tool search query.',
      );
    }
    report.providers[provider] = {
      skillVerified: answer.includes(skillMarker),
      childVerified: answer.includes(marker),
      tools,
      folder,
      usage: reply.usage,
      progressMessages: progress.length,
    };
    await writeFile('artifacts/capabilities-native-result.json', JSON.stringify(report, null, 2));
    assert(
      answer.includes(marker) && answer.includes(skillMarker),
      'The reply did not verify both fixture values.',
    );
    assert(
      tools.some((t) => t.category === 'skill' && t.status === 'complete'),
      'Missing completed skill activity.',
    );
    assert(
      tools.some((t) => t.category === 'search' && t.status === 'complete' && t.query),
      'Missing completed search query.',
    );
    assert(
      tools.some(
        (t) =>
          t.category === 'agent' &&
          t.agents.some((a) => a.status === 'complete' && a.result?.includes(marker)),
      ),
      'Missing completed child-agent result.',
    );
    await page.waitFor(() =>
      document.querySelector('.message[data-status="complete"] .activity-summary'),
    );
    assert(
      await page.evaluate(() =>
        [...document.querySelectorAll('.activity-summary')].every((el) => !el.open),
      ),
      'Completed activity should start collapsed.',
    );
    const summaryText = await page.evaluate(
      () => [...document.querySelectorAll('.activity-summary > summary')].at(-1).textContent,
    );
    const calls = tools.filter((t) => t.category !== 'agent' && t.id !== 'activity-limit').length;
    assert(summaryText.includes(`${calls} tool call`), 'Incorrect tool-call count.');
    await page.evaluate(() =>
      document.querySelector('.activity-summary')?.scrollIntoView({ block: 'center' }),
    );
    const compact = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/activity-${provider}-summary-native.png`,
      Buffer.from(compact.data, 'base64'),
    );
    await page.evaluate(() => {
      document
        .querySelectorAll('.activity-summary, .tool-card, .agent-result')
        .forEach((el) => (el.open = true));
      document.querySelector('.tool-activity')?.scrollIntoView({ block: 'start' });
    });
    const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/capabilities-${provider}-native.png`,
      Buffer.from(screenshot.data, 'base64'),
    );
    // Reload the actual native workspace and verify all persisted cards return.
    await reloadReady();
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
    await page.waitFor(() =>
      ['skill', 'search', 'agent'].every((kind) =>
        document.querySelector(`[data-category="${kind}"]`),
      ),
    );
    console.log(
      `${provider}: skill, search, sub-agent result, native rendering, and saved history verified.`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
