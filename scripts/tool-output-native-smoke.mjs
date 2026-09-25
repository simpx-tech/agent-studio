// Opt-in real Claude/Codex replies in an isolated native app: a git command, a file read and an
// image view keep their results on this computer and show them when their call is opened.
// Build with scripts/native-tool-output.tauri.json. No credentials are copied; each provider
// works in a disposable folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.tool-output-qa';
const port = Number(process.env.TOOL_OUTPUT_QA_PORT ?? 19703);
const executable = resolve(
  process.env.TOOL_OUTPUT_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const providers = (process.env.TOOL_OUTPUT_QA_PROVIDERS ?? 'claude,codex').split(',');
const data = join(process.env.LOCALAPPDATA, identifier);
const output = 'artifacts/tool-output';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });

// A 16×8 PNG, red on the left and blue on the right.
function png() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < 8; y++) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < 16; x++) rows.push(Buffer.from(x < 8 ? [220, 30, 30] : [30, 60, 220]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function fixture(provider) {
  const folder = await mkdtemp(join(tmpdir(), `studio-output-${provider}-`));
  await writeFile(join(folder, 'README.md'), '# Fixture\n');
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Agent Studio QA', '-c', 'user.email=qa@example.invalid', ...args],
      { cwd: folder, windowsHide: true },
    );
  git('init', '-q');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Fixture');
  await writeFile(join(folder, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(folder, 'pixel.png'), png());
  return folder;
}
const prompts = {
  claude:
    'This is a disposable test folder. Do exactly these steps, each as its own tool call, in order: 1) Run the shell command `git status --short`. 2) Read notes.txt with your Read tool. 3) Read the image pixel.png with your Read tool. Do not modify files or run anything else. Then reply DONE and name the two colors in the image.',
  codex:
    'This is a disposable test folder. Do exactly these steps, each as its own tool call, in order: 1) Run the shell command `git status --short`. 2) Run `Get-Content notes.txt`. 3) Look at pixel.png with your image viewing tool (view_image). Do not modify files or run anything else. Then reply DONE and name the two colors in the image.',
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

launch();
const page = await open();
const report = { checkedAt: new Date().toISOString(), providers: {} };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
try {
  const identity = await page.invoke('get_installation');
  // A first launch saves its workspace once startup detection finishes.
  await page.waitFor(async () => !!(await window.__TAURI_INTERNALS__.invoke('load_workspace')));
  const workspace = await page.invoke('load_workspace');
  assert(
    !workspace || workspace.conversations.every((c) => c.title.startsWith('Tool output QA')),
    'Use only a disposable Tool Output QA workspace.',
  );
  const chats = [];
  for (const provider of providers) {
    let account = workspace.fleet.accounts.find(
      (a) =>
        a.provider === provider &&
        workspace.fleet.connections.some(
          (c) =>
            c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
        ),
    );
    if (!account) {
      account = { id: crypto.randomUUID(), provider, name: `Tool output QA ${provider}` };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push({
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      });
    }
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    const now = new Date().toISOString();
    const chat = {
      id: crypto.randomUUID(),
      title: `Tool output QA ${provider} ${Date.now()}`,
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
      location: {
        computerId: identity.computerId,
        environmentId: identity.id,
        path: await fixture(provider),
      },
      messages: [],
    };
    workspace.conversations.push(chat);
    chats.push(chat);
  }
  await page.invoke('save_workspace', { workspace });
  await page.evaluate(() => (window.outputReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.outputReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of chats) {
    const provider = chat.settings.provider;
    assert.equal(
      (
        await page.invoke('detect_connection', {
          provider,
          connectionId: chat.settings.connectionId,
        })
      ).auth,
      'ready',
    );
    await page.click('#conversation-tab-history');
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
    await page.evaluate((text) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompts[provider]);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    const deadline = Date.now() + 300_000;
    let answer;
    while (Date.now() < deadline) {
      const saved = await page.invoke('load_workspace');
      const last = saved.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (last?.role === 'assistant' && last.status !== 'running') {
        answer = last;
        break;
      }
      await sleep(500);
    }
    assert(answer, `${provider}: reply timed out`);
    assert.equal(answer.status, 'complete', answer.error);
    const tools = answer.blocks.filter((b) => b.tool).map((b) => b.tool);
    const git = tools.find((t) => t.command?.includes('git status'));
    const read =
      tools.find((t) => t.operation === 'read' && t.path?.endsWith('notes.txt')) ??
      tools.find((t) => t.command?.includes('notes.txt'));
    const image = tools.find((t) => t.operation === 'viewImage');
    assert(git, `${provider}: no git command was recorded`);
    assert(read, `${provider}: no notes.txt read was recorded`);
    assert(image, `${provider}: no image view was recorded`);
    for (const tool of [git, read, image])
      assert(tool.output, `${provider}: ${tool.id} has no output`);
    // The synced record keeps the command and sizes; results stay in the native store.
    assert(!JSON.stringify(answer).includes('gamma'), `${provider}: output reached the record`);
    const result = (tool) =>
      page.invoke('read_tool_output', { runId: answer.runId, toolId: tool.id });
    const gitOutput = await result(git);
    assert.match(gitOutput.stdout.text, /\?\? notes\.txt/);
    assert(gitOutput.stdout.complete);
    assert.equal(gitOutput.exitCode, 0);
    const readOutput = await result(read);
    assert.match(readOutput.stdout.text, /alpha\s+beta\s+gamma/);
    const imageOutput = await result(image);
    assert.equal(imageOutput.images.length, 1, `${provider}: image not kept`);
    const pixels = await page.invoke('read_tool_output_image', {
      runId: answer.runId,
      toolId: image.id,
      index: 0,
    });
    assert.deepEqual([pixels.mediaType, pixels.width, pixels.height], ['image/png', 16, 8]);
    const stored = await readdir(join(data, 'tool-output', answer.runId));
    assert(stored.includes('run.json'));
    assert(stored.length >= 4, `${provider}: expected three results and a manifest`);
    // Each call keeps its streams and images whole in its own folder.
    const kept = await Promise.all(
      stored
        .filter((name) => name !== 'run.json')
        .map((call) => readdir(join(data, 'tool-output', answer.runId, call))),
    );
    assert(kept.every((files) => files.includes('meta.json')));
    assert(kept.some((files) => files.includes('image-0.png')));
    await page.click('[aria-label="Work history"]');
    await page.evaluate(() => {
      for (const summary of document.querySelectorAll('.activity-group > summary'))
        if (!summary.parentElement.open) summary.click();
    });
    await page.evaluate(() => {
      for (const summary of document.querySelectorAll('.tool-card > summary'))
        if (!summary.parentElement.open) summary.click();
    });
    await page.waitFor(
      () =>
        [
          ...document.querySelectorAll(
            '[aria-label="Output text"], [aria-label="File content text"]',
          ),
        ]
          .map((e) => e.textContent)
          .join('\n')
          .includes('notes.txt') && document.querySelector('.result-image img')?.naturalWidth > 0,
    );
    const ui = await page.evaluate(() => ({
      icons: [...document.querySelectorAll('.tool-card > summary [data-icon]')].map(
        (e) => e.dataset.icon,
      ),
      commands: [...document.querySelectorAll('[aria-label="Command text"]')].map(
        (e) => e.textContent,
      ),
      imageWidth: document.querySelector('.result-image img')?.naturalWidth,
    }));
    assert(ui.icons.includes('git'), `${provider}: no git icon (${ui.icons})`);
    assert(ui.commands.some((c) => c.includes('git status --short')));
    assert.equal(ui.imageWidth, 16);
    await page.evaluate(() =>
      document.querySelector('.result-image')?.scrollIntoView({ block: 'center' }),
    );
    await capture(`${provider}-native-image`);
    await page.evaluate(() =>
      document
        .querySelector('[aria-label="Command text"]')
        ?.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await capture(`${provider}-native-command`);
    report.providers[provider] = {
      chatId: chat.id,
      runId: answer.runId,
      tools: tools.map((t) => ({
        id: t.id,
        name: t.name,
        operation: t.operation,
        shell: t.shell,
        command: t.command,
        output: t.output,
      })),
      icons: ui.icons,
      stored: stored.length,
    };
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `${provider}: command, file and image results kept and shown (${stored.length} files)`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
