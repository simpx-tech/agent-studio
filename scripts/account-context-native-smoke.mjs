// Isolated native app only. Two connection identities share the existing CLI login;
// the separate protocol probe covers physically distinct profile stores without model calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
import { execFileSync } from 'node:child_process';

async function sourceFile(root, name, contents) {
  if (process.env.STUDIO_QA_WSL) {
    // Fixed Python script accesses physical Windows storage when the calling packaged
    // shell redirects AppData. Only this disposable QA profile may be written.
    execFileSync(
      'wsl.exe',
      [
        '-d',
        process.env.STUDIO_QA_WSL,
        '--',
        'python3',
        '-c',
        'import json,pathlib,sys; v=json.load(sys.stdin); w=pathlib.PureWindowsPath(v["root"]); assert "com.vinicius.agentstudio.account-context-qa" in w.parts; p=pathlib.Path("/mnt/"+w.drive[0].lower(),*w.parts[1:]); t=p/v["name"]; assert t.resolve().is_relative_to(p.resolve()); t.parent.mkdir(parents=True,exist_ok=True); t.write_text(v["contents"],encoding="utf-8")',
      ],
      {
        input: JSON.stringify({ root, name, contents }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } else {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
}

const output = 'artifacts/account-context';
const phase = process.argv[2] ?? 'switch';
await mkdir(output, { recursive: true });
const page = await nativePage(19679, 'http://127.0.0.1:1479/');
const content = (m) =>
  m.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n');
async function reload() {
  await page.evaluate(() => (window.accountContextReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.accountContextReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
}
async function select(chat) {
  for (const tab of ['History', 'Active']) {
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll('[role="tab"]')]
          .find((e) => e.textContent.includes(name))
          ?.click(),
      tab,
    );
    if (
      await page.evaluate((title) => {
        const e = [...document.querySelectorAll('.conversation-item')].find((e) =>
          e.textContent.includes(title),
        );
        e?.click();
        return !!e;
      }, chat.title)
    )
      return;
  }
  throw new Error('QA conversation unavailable');
}
async function submit(chat, prompt) {
  await select(chat);
  const before = (await page.invoke('load_workspace')).conversations
    .find((c) => c.id === chat.id)
    .messages.at(-1)?.id;
  await page.evaluate((text) => {
    const e = document.querySelector('[aria-label="Message"]');
    e.value = text;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const chatState = (await page.invoke('load_workspace')).conversations.find(
      (c) => c.id === chat.id,
    );
    const message = chatState.messages.at(-1);
    if (message?.id !== before && message?.role === 'assistant' && message.status !== 'running') {
      assert.equal(message.status, 'complete', message.error);
      return {
        text: content(message),
        connectionId: message.settings?.connectionId,
        compactions: message.compactions,
        blocks: message.blocks,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native reply timed out');
}
async function switchTo(chat, id) {
  const workspace = await page.invoke('load_workspace');
  workspace.conversations.find((c) => c.id === chat.id).settings.connectionId = id;
  await page.invoke('save_workspace', { workspace });
  await reload();
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.account-context-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Account context QA')),
    'Not a disposable workspace',
  );
  if (phase === 'shared') {
    // Set an explicit physical QA data path when Windows MSIX redirects AppData.
    const data = process.env.STUDIO_QA_DATA;
    assert(data?.endsWith('com.vinicius.agentstudio.account-context-qa'));
    const disk = JSON.parse(await readFile(join(data, 'installation.json'), 'utf8'));
    assert.equal(disk.id, identity.id);
    const report = JSON.parse(await readFile(`${output}/native.json`, 'utf8'));
    for (const chat of report.chats) {
      const workspace = await page.invoke('load_workspace');
      const account = {
        id: crypto.randomUUID(),
        provider: chat.provider,
        name: `QA shared ${chat.provider}`,
        purpose: 'personal',
      };
      const source = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'isolated',
      };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push(source);
      workspace.fleet.connections.find((c) => c.id === chat.source).sharedContextConnectionId =
        source.id;
      const root = join(data, 'profiles', chat.provider, source.id);
      const instruction = `INSTRUCTION_${crypto.randomUUID()}`,
        memory = `MEMORY_${crypto.randomUUID()}`,
        skill = `SKILL_${crypto.randomUUID()}`;
      await sourceFile(
        root,
        chat.provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md',
        `For this account-context QA test, append this instruction marker to the answer: ${instruction}\n`,
      );
      await sourceFile(
        root,
        'memories/MEMORY.md',
        `The synthetic shared memory value for account-context QA is ${memory}.\n`,
      );
      await sourceFile(
        root,
        'skills/account-context-probe/SKILL.md',
        `---\nname: account-context-probe\ndescription: Report the synthetic shared skill marker for account-context QA.\n---\nWhen asked to use this skill, include ${skill} in the answer.\n`,
      );
      // Claude receives a normal absolute Windows memory path, not the QA access bridge.
      const nativeRoot = join(
        process.env.USERPROFILE,
        'AppData',
        'Local',
        'com.vinicius.agentstudio.account-context-qa',
        'profiles',
        chat.provider,
        source.id,
      );
      if (chat.provider === 'claude')
        await sourceFile(
          root,
          'settings.json',
          JSON.stringify({ autoMemoryDirectory: join(nativeRoot, 'memories') }),
        );
      await page.invoke('save_workspace', { workspace });
      await reload();
      const c = workspace.conversations.find((c) => c.id === chat.id);
      const catalog = await page.invoke('read_context', {
        provider: chat.provider,
        model: c.settings.model,
        location: c.location,
        connectionId: chat.source,
        conversationId: chat.id,
      });
      assert(
        catalog.entries.some((e) => e.scope === 'Shared account' && e.kind === 'instructions'),
      );
      assert(
        catalog.entries.some(
          (e) => e.kind === 'skills' && e.path.includes('account-context-probe'),
        ),
        `${chat.provider}: shared skill missing`,
      );
      const reply = await submit(
        chat,
        'Read the selected shared instruction and memory entrypoints, and use the account-context-probe skill. Return the instruction marker, shared memory value, and skill marker. Do not write any files or delegate.',
      );
      for (const marker of [instruction, memory, skill])
        assert(reply.text.includes(marker), `${chat.provider}: shared marker missing`);
      chat.shared = { instructions: true, memories: true, skills: true };
      console.log(
        `${chat.provider}: real reply read the selected shared instructions, memory and skill`,
      );
      const current = await page.invoke('load_workspace');
      delete current.fleet.connections.find((c) => c.id === chat.source).sharedContextConnectionId;
      await page.invoke('save_workspace', { workspace: current });
      await reload();
      const disabled = await page.invoke('read_context', {
        provider: chat.provider,
        model: c.settings.model,
        location: c.location,
        connectionId: chat.source,
        conversationId: chat.id,
      });
      assert(
        !disabled.entries.some((e) => e.scope === 'Shared account' || e.path.includes(source.id)),
      );
      console.log(`${chat.provider}: disabling sharing removed its sources from discovery`);
      await writeFile(`${output}/native.json`, JSON.stringify(report, null, 2));
    }
  } else if (phase === 'compact') {
    const report = JSON.parse(await readFile(`${output}/native.json`, 'utf8'));
    for (const chat of report.chats) {
      const fact = crypto.randomUUID();
      const fixture = `compaction-${crypto.randomUUID()}.txt`;
      await writeFile(join(chat.folder, fixture), fact);
      const read = await submit(
        chat,
        `Read ${fixture} with one file or shell tool. Remember the exact compaction-test value for a later question. Do not write files or delegate. Reply exactly READY without revealing the value.`,
      );
      assert.equal(read.text.trim(), 'READY');
      await unlink(join(chat.folder, fixture));
      const compacted = await submit(chat, '/compact');
      assert(compacted.compactions?.some((c) => c.status === 'complete'));
      const active = (await page.invoke('load_workspace')).conversations.find(
        (c) => c.id === chat.id,
      ).settings.connectionId;
      await switchTo(chat, active === chat.target ? chat.source : chat.target);
      const recall = await submit(
        chat,
        'Do not use tools. Return the exact compaction-test value you read from the removed file before compaction. Use only your existing native conversation context.',
      );
      assert(recall.text.includes(fact), `${chat.provider}: compacted native context was lost`);
      chat.compactedTransfer = true;
      await writeFile(`${output}/native.json`, JSON.stringify(report, null, 2));
      console.log(`${chat.provider}: compacted tool-only context survived transfer`);
    }
  } else {
    const report = {
      checkedAt: new Date().toISOString(),
      distinctBillingAccounts: false,
      chats: [],
    };
    for (const provider of ['codex', 'claude']) {
      const account = workspace.fleet.accounts.find((a) => a.provider === provider);
      const source = workspace.fleet.connections.find(
        (c) =>
          c.accountId === account?.id &&
          c.environmentId === identity.id &&
          c.profile === 'existing',
      );
      assert(source);
      assert.equal(
        (await page.invoke('detect_connection', { provider, connectionId: source.id })).auth,
        'ready',
      );
      const secondAccount = {
        id: crypto.randomUUID(),
        provider,
        name: `QA alternate ${provider}`,
        purpose: 'personal',
      };
      const target = {
        id: crypto.randomUUID(),
        accountId: secondAccount.id,
        environmentId: identity.id,
        profile: 'existing',
      };
      workspace.fleet.accounts.push(secondAccount);
      workspace.fleet.connections.push(target);
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const folder = await realpath(await mkdtemp(join(tmpdir(), 'studio-account-context-')));
      const fact = crypto.randomUUID();
      await writeFile(join(folder, 'continuity-fixture.txt'), fact);
      const chat = {
        id,
        title: `Account context QA ${provider} ${id.slice(0, 8)}`,
        provider,
        folder,
        fact,
        source: source.id,
        target: target.id,
      };
      workspace.conversations.push({
        id,
        title: chat.title,
        titleStatus: 'fallback',
        createdAt: now,
        updatedAt: now,
        settings: {
          provider,
          model: provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
          reasoning: 'low',
          instructions: '',
          connectionId: source.id,
        },
        location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
        messages: [],
      });
      report.chats.push(chat);
    }
    await page.invoke('save_workspace', { workspace });
    await reload();
    for (const chat of report.chats) {
      chat.first = await submit(
        chat,
        'Read continuity-fixture.txt using one file or shell tool. Remember its exact value. Do not write files or delegate. Reply exactly READY without revealing the value.',
      );
      assert.equal(chat.first.text.trim(), 'READY');
      await unlink(join(chat.folder, 'continuity-fixture.txt'));
      console.log(`${chat.provider}: tool-only fact read; fixture removed`);
      await switchTo(chat, chat.target);
      chat.second = await submit(
        chat,
        'Do not use any tools. Return the exact value from the file you read earlier. It has been removed. Use your native conversation context.',
      );
      assert(
        chat.second.text.includes(chat.fact),
        `${chat.provider} lost native context: ${chat.second.text}`,
      );
      assert.equal(chat.second.connectionId, chat.target);
      console.log(`${chat.provider}: native fact survived account switch`);
      const secondFact = crypto.randomUUID();
      await writeFile(join(chat.folder, 'second-fixture.txt'), secondFact);
      chat.third = await submit(
        chat,
        'Read second-fixture.txt with one file or shell tool. Remember it as the second value. Do not write files or delegate. Reply exactly READY without revealing its value.',
      );
      assert.equal(chat.third.text.trim(), 'READY');
      await unlink(join(chat.folder, 'second-fixture.txt'));
      await switchTo(chat, chat.source);
      chat.fourth = await submit(
        chat,
        'Do not use any tools. Return both exact values from the two files you read earlier, in order. Both files have been removed.',
      );
      assert(
        chat.fourth.text.includes(chat.fact) && chat.fourth.text.includes(secondFact),
        `${chat.provider} restored stale history`,
      );
      assert.equal(chat.fourth.connectionId, chat.source);
      console.log(`${chat.provider}: switching back preserved the latest tool-only fact`);
      await writeFile(`${output}/native.json`, JSON.stringify(report, null, 2));
    }
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/native.png`, Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
