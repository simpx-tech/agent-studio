// Isolated native app -> Import chats against this computer's real CLI stores: list every store,
// import a Claude desktop chat and a Codex desktop chat through the dialog, open both, and continue
// the Codex one, whose first reply forks its session. Build with scripts/native-imports.tauri.json.
// The QA identity sees the computer's CLI logins only; a signed-in Codex login is needed for the
// continuation (IMPORTS_QA_CONTINUE=0 skips it). Afterwards the fork is archived in Codex and the QA
// data folder, which holds copies of the imported chats, is removed. IMPORTS_QA_WSL=1 picks chats the
// desktop apps ran in a WSL folder instead, which open on that distribution in its folder, and
// IMPORTS_QA_INSTALL=1 first installs Claude Code and Codex there through Connections.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.imports-qa';
const port = Number(process.env.IMPORTS_QA_PORT ?? 19811);
const executable = resolve(
  process.env.IMPORTS_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const data = join(process.env.LOCALAPPDATA, identifier);
const wsl = process.env.IMPORTS_QA_WSL === '1';
const output = wsl ? 'artifacts/imports-qa-wsl' : 'artifacts/imports-qa';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const report = { steps: [] };
const note = (step, detail = {}) => {
  report.steps.push({ step, ...detail });
  console.log(step, JSON.stringify(detail));
};

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
async function open() {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const page = await nativePage(port);
      assert.equal(await page.invoke('plugin:app|identifier'), identifier);
      await page.waitFor(() => document.querySelector('.template-button')?.disabled === false);
      await sleep(3000);
      assert.equal(
        await page.evaluate(
          () => document.querySelector('.error-banner')?.textContent.trim() ?? '',
        ),
        '',
      );
      await page.quitOnClose();
      return page;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}
async function shot(page, name) {
  const image = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
}
const waitLong = async (page, fn, timeout, ...args) => {
  const deadline = Date.now() + timeout;
  while (!(await page.evaluate(fn, ...args))) {
    assert(Date.now() < deadline, `Timed out: ${fn}`);
    await sleep(250);
  }
};

/** Archives a Codex thread through the CLI's own app-server, as Codex's own Archive does. */
async function archiveCodex(threadId) {
  const child = spawn('codex', ['app-server', '--stdio'], { shell: true, windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      waiting.get(value.id)?.(value);
    } catch {}
  });
  let next = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  await call('initialize', { clientInfo: { name: 'agent_studio', version: '0.0.0' } });
  child.stdin.write('{"method":"initialized"}\n');
  const archived = await call('thread/archive', { threadId });
  child.kill();
  return !archived.error;
}

/**
 * Installs, through Connections as a person would, each CLI the first WSL computer lacks. This
 * installs Claude Code and Codex for the distribution's default user with their own installers.
 */
async function installInWsl(page) {
  await page.button('Connections');
  // The provider's card on the first WSL computer, read inside the page.
  const read = (name) => {
    const article = [...document.querySelectorAll('article.fleet-computer')]
      .find((c) => c.getAttribute('aria-label')?.startsWith('WSL'))
      ?.querySelector(`article[aria-label="${name} connections"]`);
    return {
      status: article?.querySelector('.installation-status')?.textContent ?? '',
      error: article?.querySelector('.cli-install .sync-error')?.textContent.trim() ?? '',
      path: article?.querySelector('.cli-location code')?.textContent ?? '',
      add: [...(article?.querySelectorAll('.add-accounts button') ?? [])].map((b) =>
        b.textContent.trim(),
      ),
    };
  };
  const card = (name) => page.evaluate(read, name);
  for (const name of ['Claude', 'Codex']) {
    const deadline = Date.now() + 60_000;
    while (!/^(Installed|Not installed)$/.test((await card(name)).status)) {
      assert(Date.now() < deadline, `${name} installation state never settled`);
      await sleep(500);
    }
    if ((await card(name)).status === 'Installed') {
      note('already installed in WSL', { name });
      continue;
    }
    const started = Date.now();
    await page.button(`Install ${name}`);
    for (;;) {
      const state = await card(name);
      if (state.status === 'Installed' || state.error) break;
      assert(Date.now() - started < 16 * 60_000, `${name} did not install in time`);
      await sleep(1000);
    }
    const outcome = await card(name);
    note('installed in WSL', { name, ms: Date.now() - started, ...outcome });
    assert.equal(outcome.error, '');
    assert.equal(outcome.status, 'Installed');
  }
  await shot(page, 'wsl-installed');
}

let page;
let forked;
try {
  launch();
  page = await open();
  note('opened');
  if (wsl && process.env.IMPORTS_QA_INSTALL === '1') await installInWsl(page);
  // Every store, read the way the dialog reads it, with timings.
  const sources = await page.invoke('list_import_sources');
  const listings = [];
  for (const source of sources) {
    const started = Date.now();
    try {
      const listing = await page.invoke('list_importable_chats', { source: source.id });
      listings.push({ source, chats: listing.chats });
      note('listed', {
        source: source.id.replace(/:[0-9a-f-]{36}/g, ':…'),
        chats: listing.chats.length,
        ms: Date.now() - started,
        origins: Object.fromEntries(
          [...new Set(listing.chats.map((c) => c.origin))].map((o) => [
            o,
            listing.chats.filter((c) => c.origin === o).length,
          ]),
        ),
        unavailable: listing.chats.filter((c) => c.unavailable).length,
      });
    } catch (error) {
      note('listing failed', {
        source: source.id.replace(/:[0-9a-f-]{36}/g, ':…'),
        error: String(error),
      });
    }
  }
  const all = listings.flatMap(({ source, chats }) =>
    chats.map((chat) => ({ ...chat, provider: source.provider })),
  );
  const ran = (c) => Date.parse(c.updatedAt ?? 0) - Date.parse(c.createdAt ?? 0);
  const pick = (provider) =>
    all
      .filter(
        (c) =>
          c.provider === provider &&
          c.origin === 'desktop' &&
          c.location &&
          // An account not signed in inside the distribution still places the chat there.
          (!c.unavailable || (wsl && c.unavailable.startsWith('Connect '))) &&
          !c.conversationId &&
          // Codex lists a thread it ran in WSL by the folder's \\wsl.localhost path.
          (wsl
            ? /^\/home\//.test(c.path) || c.path.startsWith('\\\\wsl.localhost\\')
            : /^[A-Za-z]:\\/.test(c.path)) &&
          (c.bytes ?? 0) < 12 * 1024 * 1024 &&
          // A short WSL thread keeps the continuation's context small.
          (!wsl || provider === 'claude' || ran(c) < 30 * 60_000),
      )
      .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))[0];
  const claude = pick('claude');
  const codex = pick('codex');
  assert(claude && codex, 'A Claude and a Codex desktop chat to import');
  note('picked', { claude: claude.title.length, codex: codex.title.length });
  // Each session opens in one place, whichever of the stores that keep it is read.
  const sessions = new Map();
  for (const chat of all) sessions.set(chat.session, [...(sessions.get(chat.session) ?? []), chat]);
  const copies = [...sessions.values()].filter((list) => list.length > 1);
  note('copies', {
    sessions: copies.length,
    openDifferently: copies.filter((list) =>
      list.some(
        (c) =>
          c.location?.environmentId !== list[0].location?.environmentId ||
          c.location?.executionEnvironmentId !== list[0].location?.executionEnvironmentId,
      ),
    ).length,
  });
  if (wsl) {
    // A Windows app's WSL chat runs inside the distribution, in its folder, with its CLI there.
    const fleet = (await page.invoke('load_workspace')).fleet;
    const environment = (id) => fleet.environments.find((e) => e.id === id);
    for (const chat of [claude, codex]) {
      const folder = environment(chat.location.environmentId);
      const runs = environment(chat.location.executionEnvironmentId ?? chat.location.environmentId);
      const account = fleet.connections.find((c) => c.id === chat.connectionId);
      note('placed', {
        provider: chat.provider,
        folder: folder?.platform,
        runs: runs?.platform,
        account: environment(account?.environmentId)?.platform,
        unavailable: chat.unavailable ?? '',
      });
      assert.equal(folder?.platform, 'wsl');
      assert.equal(runs?.id, folder.id);
      if (account) assert.equal(account.environmentId, runs.id);
    }
  }

  // The dialog, from Settings.
  await page.button('Settings');
  await page.button('Import chats');
  const started = Date.now();
  await waitLong(
    page,
    () => !document.querySelector('.import-status')?.textContent.includes('Reading'),
    120_000,
  );
  const rows = await page.evaluate(() => document.querySelectorAll('.import-row').length);
  note('dialog listed', { rows, ms: Date.now() - started });
  await shot(page, 'dialog');
  for (const chat of [claude, codex])
    await page.evaluate((title) => {
      const box = [...document.querySelectorAll('.import-row input[type=checkbox]')].find(
        (input) => input.getAttribute('aria-label') === `Import ${title}`,
      );
      if (!box) throw new Error(`No row for ${title}`);
      box.click();
    }, chat.title);
  const importing = Date.now();
  await page.button('Import 2 chats');
  await waitLong(
    page,
    () =>
      !!document.querySelector('.import-summary') ||
      !!document.querySelector('.import-chats .error-banner'),
    240_000,
  );
  const summary = await page.evaluate(
    () => document.querySelector('.import-summary')?.textContent.trim() ?? '',
  );
  const errors = await page.evaluate(
    () => document.querySelector('.import-chats .error-banner')?.textContent.trim() ?? '',
  );
  note('imported', { summary, errors, ms: Date.now() - importing });
  assert.equal(errors, '');
  await shot(page, 'dialog-imported');

  const workspace = await page.invoke('load_workspace');
  const conversations = [claude, codex].map((chat) =>
    workspace.conversations.find(
      (c) => c.title === chat.title.slice(0, 100) || c.title.startsWith(chat.title.slice(0, 60)),
    ),
  );
  assert(conversations.every(Boolean), 'Both chats saved');
  for (const [index, conversation] of conversations.entries())
    note('saved', {
      provider: conversation.settings.provider,
      archived: conversation.archived,
      messages: conversation.messages.length,
      replies: conversation.messages.filter((m) => m.role === 'assistant').length,
      calls: conversation.messages.flatMap((m) => m.blocks).filter((b) => b.tool).length,
      answers: conversation.messages.filter(
        (m) =>
          m.role === 'assistant' && m.blocks.some((b) => b.type === 'markdown' && b.text.trim()),
      ).length,
      images: conversation.messages.flatMap((m) => m.images ?? []).length,
      chat: index ? 'codex' : 'claude',
    });

  // Open the Claude chat from its row and look at its first call's result, read from the store.
  await page.evaluate((title) => {
    const row = [...document.querySelectorAll('.import-row')].find(
      (r) => r.querySelector('strong')?.textContent === title,
    );
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open').click();
  }, claude.title);
  await page.waitFor(() => !document.querySelector('.import-chats'));
  await sleep(1500);
  const shown = await page.evaluate(() => ({
    title: document.querySelector('.page-title')?.textContent.trim(),
    messages: document.querySelectorAll('[data-testid="message"]').length,
  }));
  note('opened claude chat', { messages: shown.messages });
  await shot(page, 'claude-chat');
  const result = await page
    .evaluate(
      async (runId, conversation) => {
        const message = conversation.messages.find((m) => m.runId === runId);
        const tool = message.blocks.find((b) => b.tool && b.tool.output)?.tool;
        if (!tool) return 'no recorded result';
        const view = await window.__TAURI_INTERNALS__.invoke('read_tool_output', {
          runId,
          toolId: tool.id,
          full: false,
        });
        return `${tool.name}: ${(view.stdout?.bytes ?? 0) + (view.stderr?.bytes ?? 0)} bytes read back`;
      },
      conversations[0].messages.find(
        (m) => m.role === 'assistant' && m.blocks.some((b) => b.tool?.output),
      )?.runId,
      conversations[0],
    )
    .catch((error) => String(error));
  note('tool result', { result });

  // Continue the Codex chat: its first reply forks the session and answers from its history.
  // A WSL chat continues only once an account is signed in inside the distribution.
  if (process.env.IMPORTS_QA_CONTINUE !== '0' && !wsl) {
    await page.button('Settings');
    await page.button('Import chats');
    await waitLong(
      page,
      () => !document.querySelector('.import-status')?.textContent.includes('Reading'),
      120_000,
    );
    await page.evaluate((title) => {
      const row = [...document.querySelectorAll('.import-row')].find(
        (r) => r.querySelector('strong')?.textContent === title,
      );
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open').click();
    }, codex.title);
    await page.waitFor(() => !document.querySelector('.import-chats'));
    const input = 'In one short sentence, what was the very first thing I asked you in this chat?';
    await page.evaluate((text) => {
      const box = document.querySelector('textarea[aria-label="Message"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, input);
    await page.button('Send message');
    const sent = Date.now();
    await waitLong(
      page,
      () => {
        const last = [...document.querySelectorAll('[data-testid="message"]')].at(-1);
        return (
          last && ['complete', 'error', 'cancelled'].includes(last.getAttribute('data-status'))
        );
      },
      300_000,
    );
    const reply = await page.evaluate(() => {
      const last = [...document.querySelectorAll('[data-testid="message"]')].at(-1);
      return { status: last.getAttribute('data-status'), text: last.innerText.slice(0, 600) };
    });
    note('continued codex chat', {
      status: reply.status,
      ms: Date.now() - sent,
      forkedNote: reply.text.includes('Continuing this imported chat'),
    });
    await shot(page, 'codex-continued');
    const binding = JSON.parse(
      await readFile(join(data, 'native-sessions', `${conversations[1].id}.json`), 'utf8'),
    );
    if (wsl) {
      // The fork's own record of the folder its turn ran in.
      const { readdir } = await import('node:fs/promises');
      const rollouts = await readdir(join(process.env.USERPROFILE, '.codex', 'sessions'), {
        recursive: true,
      });
      const rollout = rollouts.find((name) => name.endsWith(`${binding.id}.jsonl`));
      const cwd = rollout
        ? (await readFile(join(process.env.USERPROFILE, '.codex', 'sessions', rollout), 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"turn_context"'))
            .map((line) => JSON.parse(line).payload?.cwd)
            .at(-1)
        : undefined;
      note('codex ran in', { cwd, saved: conversations[1].location.path });
      assert.match(cwd ?? '', /^\\\\wsl\.localhost\\/);
    }
    forked = binding.id;
    note('codex fork', { forkedFromImport: true, differs: binding.id !== undefined });
    report.reply = reply.text;
    assert.equal(reply.status, 'complete');
  }
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (page) {
    report.pageErrors = page.errors;
    try {
      await page.button('Close window');
    } catch {}
    page.close();
  }
  await sleep(4000);
  if (forked) note('archived fork in Codex', { ok: await archiveCodex(forked).catch(() => false) });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
process.exit(0);
