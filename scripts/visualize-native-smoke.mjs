// Real installed CLI calls, using only the explicitly isolated QA app.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
import { checkNativeArtifact } from './artifact-native-check.mjs';
import {
  explanationBefore,
  explanationAfter,
  explanationSource,
} from './visualization-example.mjs';

const port = 9493;
const page = await nativePage(port);
const report = { checkedAt: new Date().toISOString() };
const explanation = process.env.QA_EXPLANATION === '1';
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.visualize-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Visualize QA')),
    'Not a disposable workspace',
  );
  const folder = await mkdtemp(join(tmpdir(), 'studio-visualize-'));
  const chats = [];
  for (const provider of (process.env.QA_PROVIDERS ?? 'claude,codex').split(',')) {
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `Missing ${provider} connection`);
    const state = await page.invoke('detect_connection', { provider, connectionId: connection.id });
    assert.equal(state.auth, 'ready', `${provider} needs sign-in`);
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const title = `Visualize QA ${provider} ${id.slice(0, 8)}`;
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      messages: [],
    });
    chats.push({ id, provider, title });
  }
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of chats) {
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
      chat.title,
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((e) => e.textContent.includes(title))
          .click(),
      chat.title,
    );
    await page.evaluate(
      (provider, explanation, source, before, after) => {
        const el = document.querySelector('[aria-label="Message"]');
        el.value = explanation
          ? `Explain parallel work using the visualize tool once, id parallel, title Native Visual, with this exact HTML:\n${source}\n\nUse this paragraph before the visual: ${before}\n\nUse this paragraph after the visual: ${after}\nDo not read files, run shell commands, search, delegate, or call other integrations. Do not repeat the HTML in the answer.`
          : `Test the actual ${provider === 'claude' ? 'mcp__agent_studio__visualize' : 'visualize'} tool. Call it with id counter, title Native Visual, and self-contained HTML with a heading Native Visual, button Add one, output id count initially 0, and inline JavaScript incrementing the output on click. Then call that same tool again with id counter to replace it with the same counter starting at 10. Exactly two visualization calls. Do not read files, run shell commands, search the web, delegate, or use other integrations. Do not emit HTML fences or local-file references. Finish with one short sentence.`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      chat.provider,
      explanation,
      explanationSource,
      explanationBefore,
      explanationAfter,
    );
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    console.log(`${chat.provider}: waiting for actual tool calls and owned process completion`);
    let reply;
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const current = await page.invoke('load_workspace');
      reply = current.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(reply?.status, 'complete', reply?.error);
    assert.equal(reply.visualizations?.length, 1, 'No accepted native visualization');
    assert.equal(
      reply.visualizations[0].revision,
      explanation ? 1 : 2,
      'Unexpected visualization revision',
    );
    const tools = reply.blocks.flatMap((b) => (b.tool ? [b.tool] : []));
    assert.equal(
      tools.filter((t) => /visualize/i.test(t.name) && t.status === 'complete').length,
      explanation ? 1 : 2,
    );
    await page.waitFor(() => document.querySelector('iframe[title="Native Visual visualization"]'));
    const boundaries = await checkNativeArtifact(port, explanation);
    assert.equal(boundaries.before, explanation ? 3 : 10);
    if (explanation) {
      const text = reply.blocks
        .filter((b) => b.type === 'markdown')
        .map((b) => b.text)
        .join('');
      assert(text.includes('<!-- visualize:parallel -->'), 'Provider did not position its visual');
      assert.equal(boundaries.background, 'rgba(0, 0, 0, 0)');
      assert.equal(boundaries.fontLoaded, true);
      await page.waitFor((contentHeight) => {
        const content = document.querySelector('.message:not(.user):last-of-type .message-content');
        const visual = content?.querySelector('.visualization');
        return (
          visual?.previousElementSibling?.classList.contains('prose') &&
          visual?.nextElementSibling?.classList.contains('prose') &&
          Math.abs(visual.querySelector('iframe').clientHeight - contentHeight) < 2
        );
      }, Math.ceil(boundaries.height));
      await page.evaluate(() =>
        document
          .querySelector('.message:not(.user):last-of-type')
          ?.scrollIntoView({ block: 'start' }),
      );
    }
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/visualize-${explanation ? 'flow-' : ''}native-${chat.provider}.png`,
      Buffer.from(shot.data, 'base64'),
    );
    report[chat.provider] = {
      conversationId: chat.id,
      status: reply.status,
      revision: reply.visualizations[0].revision,
      toolCalls: tools
        .filter((t) => /visualize/i.test(t.name))
        .map((t) => ({ name: t.name, status: t.status })),
      boundaries,
    };
    console.log(`${chat.provider}: actual visualization calls and native interaction passed`);
  }
  assert.equal(page.errors.length, 0);
  await writeFile(
    `artifacts/visualize-${explanation ? 'flow-' : ''}native-result.json`,
    JSON.stringify(report, null, 2),
  );
} finally {
  page.close();
}
