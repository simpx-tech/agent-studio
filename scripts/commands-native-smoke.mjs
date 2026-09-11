// Real selected CLI catalog -> slash composer -> native skill -> saved reply.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9466);
const report = { checkedAt: new Date().toISOString(), providers: {} };
async function verifySaved(saved, provider, skillPath, marker, argument) {
  const reply = saved.messages.at(-1);
  assert.equal(reply?.status, 'complete', reply?.error ?? 'Reply timed out');
  const answer = reply.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
  assert(answer.includes(marker), 'Skill marker missing');
  assert(answer.includes(argument), 'Argument missing');
  assert.equal(saved.messages[0].blocks[0].text, `/slash-check ${argument}`);
  if (provider === 'codex') {
    assert.equal(saved.messages[0].skills?.length, 1);
    assert.equal(saved.messages[0].skills[0].name, 'slash-check');
    assert.equal(await realpath(saved.messages[0].skills[0].path), await realpath(skillPath));
  }
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/slash-${provider}-reply-native.png`, Buffer.from(shot.data, 'base64'));
  report.providers[provider] = {
    skillVerified: true,
    argumentsVerified: true,
    sourceSaved: provider === 'codex',
    folder: saved.location.path,
    replyStatus: reply.status,
  };
  await writeFile('artifacts/commands-native-result.json', JSON.stringify(report, null, 2));
  console.log(`Verified native ${provider} skill and arguments.`);
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.commands-qa');
  await page.waitFor(
    () =>
      !!document.querySelector('[aria-label="New conversation"]') &&
      !document.querySelector('[aria-label="New conversation"]').disabled,
  );
  const identity = await page.invoke('get_installation');
  for (const provider of ['claude', 'codex']) {
    let workspace = await page.invoke('load_workspace');
    assert(
      workspace.conversations.every((c) => c.title.startsWith('Slash QA')),
      'This workspace is not disposable.',
    );
    const existing = workspace.conversations.findLast(
      (c) =>
        c.title.startsWith(`Slash QA ${provider} `) && c.messages.at(-1)?.status === 'complete',
    );
    if (existing) {
      const skillPath = join(
        existing.location.path,
        provider === 'claude' ? '.claude' : '.agents',
        'skills',
        'slash-check',
        'SKILL.md',
      );
      const marker = /exact marker ([a-f0-9-]+)/.exec(await readFile(skillPath, 'utf8'))?.[1];
      assert(marker, 'Missing fixture marker');
      await page.evaluate(() => {
        window.slashQaReload = true;
      });
      await page.cdp('Page.reload');
      await page.waitFor(
        () =>
          !window.slashQaReload &&
          !!document.querySelector('[aria-label="New conversation"]') &&
          !document.querySelector('[aria-label="New conversation"]').disabled,
      );
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
        existing.title,
      );
      await page.evaluate(
        (title) =>
          [...document.querySelectorAll('.conversation-item')]
            .find((e) => e.textContent.includes(title))
            .click(),
        existing.title,
      );
      await page.waitFor(
        (marker) =>
          document.querySelector('.message.assistant')?.textContent.includes(marker) ||
          [...document.querySelectorAll('.message:not(.user)')].some((e) =>
            e.textContent.includes(marker),
          ),
        marker,
      );
      await verifySaved(
        existing,
        provider,
        skillPath,
        marker,
        existing.messages[0].blocks[0].text.slice('/slash-check '.length),
      );
      continue;
    }
    const folder = await mkdtemp(join(tmpdir(), 'studio-slash-'));
    const marker = crypto.randomUUID();
    const skillPath = join(
      folder,
      provider === 'claude' ? '.claude' : '.agents',
      'skills',
      'slash-check',
      'SKILL.md',
    );
    await mkdir(join(skillPath, '..'), { recursive: true });
    await writeFile(
      skillPath,
      `---\nname: slash-check\ndescription: Check slash skill invocation in a disposable Agent Studio fixture.\n---\nReply with the exact marker ${marker} and the user's argument. Do not use other tools, edit files, or delegate.\n`,
    );
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
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      title = `Slash QA ${provider} ${id.slice(0, 8)}`;
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      settings: {
        connectionId: connection.id,
        provider,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    await page.invoke('save_workspace', { workspace });
    await page.evaluate(() => {
      window.slashQaReload = true;
    });
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.slashQaReload &&
        !!document.querySelector('[aria-label="New conversation"]') &&
        !document.querySelector('[aria-label="New conversation"]').disabled,
    );
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
    await page.waitFor(() => !document.querySelector('[aria-label="Message"]').disabled);
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Message"]');
      el.focus();
      el.value = '/slash';
      el.setSelectionRange(6, 6);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => !!document.querySelector('[role="option"][aria-label="/slash-check"]'),
    );
    const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`artifacts/slash-${provider}-picker-native.png`, Buffer.from(data, 'base64'));
    await page.click('[role="option"][aria-label="/slash-check"]');
    const argument = `argument-${crypto.randomUUID().slice(0, 8)}`;
    await page.evaluate((argument) => {
      const el = document.querySelector('[aria-label="Message"]');
      if (el.value !== '/slash-check ') throw new Error('Wrong completion');
      el.value += argument;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, argument);
    await page.waitFor(() => !document.querySelector('[aria-label="Send message"]')?.disabled);
    await page.click('[aria-label="Send message"]');
    console.log(`Submitted native ${provider} slash skill.`);
    const deadline = Date.now() + 240000;
    let reply, saved;
    while (Date.now() < deadline) {
      workspace = await page.invoke('load_workspace');
      saved = workspace.conversations.find((c) => c.id === id);
      reply = saved.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await verifySaved(saved, provider, skillPath, marker, argument);
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
