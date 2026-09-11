// Opt-in: cancel a native workflow in the isolated work-features QA app.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const p = await nativePage(9487);
const report = JSON.parse(await readFile('artifacts/work-features-native-result.json', 'utf8'));
const processes = () =>
  JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, encoding: 'utf8' },
    ),
  );
try {
  assert.equal(
    await p.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.work-features-qa',
  );
  const w = await p.invoke('load_workspace');
  const chat = w.conversations.find((c) => c.id === report.claude.conversationId);
  assert(chat?.title.startsWith('Work Features QA claude'));
  assert(!w.conversations.some((c) => c.messages.at(-1)?.status === 'running'));
  assert(chat.location.path.includes('studio-work-features-'));
  const source =
    'export const meta={name:"studio-native-cancel",description:"Cancellation fixture",phases:["Wait"]}; phase("Wait"); return await agent("Use Bash to run sleep 30, then return CANCEL_FIXTURE_DONE. No file reads, edits, or other work.",{label:"Waiting agent"});';
  await writeFile(join(chat.location.path, '.claude/workflows/studio-native-cancel.js'), source);
  await p.cdp('Page.reload');
  await p.waitFor(() => !!document.querySelector('[role="tab"]'));
  await p.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('History'))
      .click(),
  );
  await p.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((e) =>
        e.textContent.includes(title),
      ),
    chat.title,
  );
  await p.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((e) => e.textContent.includes(title))
        .click(),
    chat.title,
  );
  await p.evaluate(() => {
    const el = document.querySelector('[aria-label="Message"]');
    el.value = 'Run /studio-native-cancel with the native Workflow tool and wait for it to finish.';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitFor(() => document.querySelector('[aria-label="Send message"]')?.disabled === false);
  const initialProcesses = processes();
  const appPath = join(
    process.cwd(),
    'artifacts/native-federation-target/debug/agent-studio.exe',
  ).toLowerCase();
  const app = initialProcesses.filter((r) => r.ExecutablePath?.toLowerCase() === appPath);
  assert.equal(app.length, 1, 'Cannot identify one isolated QA process');
  const before = new Set(
    initialProcesses.filter((r) => r.Name === 'claude.exe').map((r) => r.ProcessId),
  );
  await p.button('Send message');
  await p.waitFor(
    () => !!document.querySelector('.composer-area .native-workflow-panel .workflow-agent'),
  );
  const running = (await p.invoke('load_workspace')).conversations
    .find((c) => c.id === chat.id)
    .messages.at(-1);
  assert.equal(running.status, 'running');
  const live = processes(),
    descendants = new Set([app[0].ProcessId]);
  for (let i = 0; i < live.length; i++) {
    const size = descendants.size;
    for (const r of live) if (descendants.has(r.ParentProcessId)) descendants.add(r.ProcessId);
    if (descendants.size === size) break;
  }
  const started = live.filter(
    (r) => r.Name === 'claude.exe' && descendants.has(r.ProcessId) && !before.has(r.ProcessId),
  );
  assert(started.length, 'No owned CLI process observed');
  await p.button('Stop response');
  let saved;
  for (let i = 0; i < 60; i++) {
    saved = (await p.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      .messages.at(-1);
    if (saved.status === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(saved.status, 'cancelled');
  const after = new Set(processes().map((r) => r.ProcessId));
  assert(
    started.every((r) => !after.has(r.ProcessId)),
    'Owned Claude process survived cancellation',
  );
  await p.evaluate(() => {
    const panel = [...document.querySelectorAll('.message .native-workflow-panel')].at(-1);
    panel.open = true;
    panel.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await writeFile(
    'artifacts/native-workflow-cancel-native.png',
    Buffer.from((await p.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  report.nativeCancellation = {
    verified: true,
    runId: running.runId,
    ownedCliProcessesStopped: started.length,
    status: saved.status,
  };
  await writeFile('artifacts/work-features-native-result.json', JSON.stringify(report, null, 2));
  console.log('Native workflow cancellation and owned process exit verified');
} finally {
  p.close();
}
