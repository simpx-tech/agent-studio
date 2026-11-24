// Opt-in real-provider proof of comparisons (docs/COMPARISONS.md). Run against the isolated QA
// build of scripts/native-comparisons.tauri.json (docs/VERIFICATION.md, 2026-11-24); only that
// identity's data and a disposable repository change. The same task and Codex model run twice in
// worktrees of one snapshot of the repository; the second run is picked, applied to the folder,
// and the worktrees are removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const output = 'artifacts/comparisons';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A checkout may turn line endings into CRLF (core.autocrlf).
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const page = await nativePage(19931, 'http://tauri.localhost/');
const report = { checkedAt: new Date().toISOString() };
let failure;
try {
  await page.waitFor(() => !!window.__TAURI_INTERNALS__?.invoke);
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.comparisons-qa',
  );
  await page.quitOnClose();
  await page.waitFor(() => document.querySelector('[aria-label="Message"]'));
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.innerText ?? null),
    null,
  );
  const installation = await page.invoke('get_installation');
  let workspace;
  const login = () =>
    workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === 'codex'),
    );
  for (const deadline = Date.now() + 90000; Date.now() < deadline; await sleep(1000)) {
    workspace = await page.invoke('load_workspace');
    if (login()) break;
  }
  assert(login(), 'No Codex login was found on this computer');

  // A repository with a commit, an uncommitted change, an untracked file and an ignored .env that
  // .worktreeinclude names.
  const folder = await mkdtemp(join(tmpdir(), 'studio-compare-'));
  git(folder, 'init', '-q');
  git(folder, 'config', 'user.email', 'qa@localhost');
  git(folder, 'config', 'user.name', 'QA');
  await writeFile(join(folder, 'notes.txt'), 'one\n');
  await writeFile(join(folder, '.gitignore'), '.env\n');
  await writeFile(join(folder, '.worktreeinclude'), '.env\n');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', 'first');
  await writeFile(join(folder, 'notes.txt'), 'one\ntwo\n');
  await writeFile(join(folder, 'draft.txt'), 'untracked\n');
  await writeFile(join(folder, '.env'), 'TOKEN=local\n');
  const statusBefore = git(folder, 'status', '--porcelain');

  // A new chat on this folder with the Codex login, through the folder browser and the pickers.
  const pick = (label, text) =>
    page.evaluate(
      async (label, text) => {
        document.querySelector(`[role="combobox"][aria-label="${label}"]`).click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const option = [...document.querySelectorAll('[role="option"]')].find((o) =>
          o.textContent.includes(text),
        );
        if (!option) throw new Error(`No ${label} option ${text}`);
        option.click();
      },
      label,
      text,
    );
  await page.button('New conversation');
  await pick('Folder', 'Browse folders');
  // The browser lists its first folder before its controls take input.
  await page.waitFor(() => document.querySelector('[aria-label="Edit path"]')?.disabled === false);
  await page.click('[aria-label="Edit path"]');
  await page.waitFor(() => document.querySelector('[aria-label="Folder path"]'));
  await page.evaluate((path) => {
    const input = document.querySelector('[aria-label="Folder path"]');
    input.value = path;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  }, folder);
  await page.waitFor(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.innerText.trim() === 'Use this folder' && !b.disabled,
    ),
  );
  await sleep(1000);
  await page.button('Use this folder');
  await page.waitFor(
    (name) =>
      document.querySelector('[role="combobox"][aria-label="Folder"]')?.textContent.includes(name),
    folder.split(/[\\/]/).at(-1),
  );
  await sleep(1000);
  await pick('Agent', 'Codex');
  await sleep(1500);

  // Compare: the toolbar's choice, run twice.
  await page.button('Compare');
  await page.waitFor(() => document.querySelector('.compare-add'));
  await page.click('.compare-add');
  await page.waitFor(() =>
    document.querySelector('[aria-label="Runs"]')?.textContent.includes('2 runs'),
  );
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value =
      'This is an Agent Studio integration test in a disposable git repository. Do exactly this and nothing else: create a file named hello.txt in the current folder containing the single word hi. Run no other command. Then reply with OK, followed by the name of the git branch your instructions say this conversation works on, or NONE if they name none.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.click('[aria-label="Send message"]');

  // Both runs start in worktrees of their own and finish.
  let comparison;
  let runs = [];
  for (const deadline = Date.now() + 300000; Date.now() < deadline; await sleep(1000)) {
    workspace = await page.invoke('load_workspace');
    comparison = workspace.comparisons?.[0];
    runs = (comparison?.runs ?? []).map((run) =>
      workspace.conversations.find((c) => c.id === run.conversationId),
    );
    const replies = runs.map((chat) => chat?.messages.at(-1));
    if (
      replies.length === 2 &&
      replies.every((m) => m?.role === 'assistant' && m.status !== 'running')
    )
      break;
  }
  assert.equal(comparison?.isolation, 'worktree', JSON.stringify(comparison));
  assert.equal(runs.length, 2);
  report.comparison = comparison;
  report.runs = [];
  for (const [index, chat] of runs.entries()) {
    const reply = chat.messages.at(-1);
    assert.equal(reply.status, 'complete', reply.error);
    const path = chat.location.path;
    const branch = comparison.runs[index].branch;
    assert.notEqual(path, folder);
    assert.match(path, /worktrees/);
    // The snapshot held the uncommitted change, the untracked file and the included .env.
    assert.equal(read(join(path, 'notes.txt')), 'one\ntwo\n');
    assert.equal(read(join(path, 'draft.txt')), 'untracked\n');
    assert.equal(readFileSync(join(path, '.env'), 'utf8'), 'TOKEN=local\n');
    assert.equal(readFileSync(join(path, 'hello.txt'), 'utf8').trim(), 'hi');
    assert.equal(git(path, 'branch', '--show-current'), branch);
    const text = reply.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('\n');
    report.runs.push({ path, branch, text, model: reply.modelName, durationMs: reply.durationMs });
    // The run read the note about its worktree.
    assert(text.includes(branch), `Run ${index + 1} did not name its branch: ${text}`);
  }
  // The folder itself is as it was.
  assert(!existsSync(join(folder, 'hello.txt')));
  assert.equal(git(folder, 'status', '--porcelain'), statusBefore);
  await mkdir(output, { recursive: true });
  await page.waitFor(() => document.querySelectorAll('.comparison-run').length === 2);
  await sleep(1000);
  const capture = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/native-comparison.png`, Buffer.from(capture.data, 'base64'));

  // Pick the second run and apply it to the folder.
  await page.evaluate(() =>
    [...document.querySelectorAll('.comparison-run')][1].querySelector('.run-pick').click(),
  );
  await page.waitFor(() => !!document.querySelector('.run-pick[aria-pressed="true"]'));
  await page.button('Apply to folder');
  await page.waitFor(() =>
    document.querySelector('[aria-label="Files to change"]')?.textContent.includes('hello.txt'),
  );
  report.applied = await page.evaluate(
    () => document.querySelector('[aria-label="Files to change"]').innerText,
  );
  await page.button('Apply');
  await page.waitFor(() => document.querySelector('.comparison-applied'));
  assert.equal(readFileSync(join(folder, 'hello.txt'), 'utf8').trim(), 'hi');
  assert.match(git(folder, 'status', '--porcelain'), /\?\? hello\.txt/);

  // Remove the worktrees and their branches.
  await page.button('Remove worktrees');
  await page.button('Remove');
  for (const deadline = Date.now() + 60000; Date.now() < deadline; await sleep(500)) {
    workspace = await page.invoke('load_workspace');
    if (workspace.comparisons?.[0]?.removed) break;
  }
  assert(workspace.comparisons?.[0]?.removed, 'The worktrees were not removed');
  for (const run of report.runs) assert(!existsSync(run.path), run.path);
  assert.equal(git(folder, 'branch', '--list', 'agent-studio/*'), '');
  assert.deepEqual(page.errors, []);
  console.log(JSON.stringify(report.runs, null, 2));
} catch (error) {
  failure = error;
} finally {
  report.errors = page.errors;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  // Closing from the title bar releases the app's parked CLIs.
  await page.button('Close window').catch(() => {});
  page.close();
}
if (failure) console.error(failure);
// The debugging socket can outlive its close request and keep Node running.
process.exit(failure ? 1 : 0);
