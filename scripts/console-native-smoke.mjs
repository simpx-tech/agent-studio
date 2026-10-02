// Opt-in native proof that Run in console opens real consoles from the desktop app: PowerShell,
// Command Prompt and Git Bash in a chat's project folder on Windows, and a console inside the
// first WSL distribution for a chat that runs there. Each block leaves a marker in its folder,
// and this driver reads what each console shows before closing it. The consoles are real
// windows on the screen for a few seconds. No provider runs. Build with
// scripts/native-console.tauri.json (CDP 19771); CONSOLE_QA_EXECUTABLE names the built exe.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativePage } from './native-page.mjs';

const identifier = 'com.vinicius.agentstudio.console-qa';
const executable = resolve(
  process.env.CONSOLE_QA_EXECUTABLE ?? 'src-tauri/target/debug/agent-studio.exe',
);
const output = resolve('artifacts/console');
// A folder name that would break a command line written carelessly.
const project = resolve(output, "My Project (QA) & 'quoted' ñ");
const linuxFolder = "/tmp/studio console qa 'quoted' $(literal) ñ";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const powershell = (script, env = {}) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
await rm(output, { recursive: true, force: true });
await mkdir(project, { recursive: true });

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
async function connect() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = await nativePage(19771);
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
const page = await connect();
await page.quitOnClose();
// This QA identity never updates the computer's CLIs by itself.
for (const provider of ['claude', 'codex'])
  await page.invoke('set_cli_auto_update', { provider, automatic: false }).catch(() => {});

// The consoles the QA app opened: its own child shells, told apart by how they were started.
const consoles = () =>
  JSON.parse(
    powershell(
      `$apps = @(Get-CimInstance Win32_Process -Filter "Name='agent-studio.exe'" | Where-Object { $_.ExecutablePath -eq $env:QA_EXE } | ForEach-Object { $_.ProcessId })
$found = @(Get-CimInstance Win32_Process | Where-Object { $apps -contains $_.ParentProcessId -and $_.CommandLine -match 'EncodedCommand|/S /K|launch\\.sh|agent-studio-console' } | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } })
ConvertTo-Json -InputObject $found -Compress`,
      { QA_EXE: executable },
    ) || '[]',
  );
const closeConsoles = () => {
  for (const { pid } of consoles())
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // It already closed.
    }
};
// What a console shows: its screen buffer, read by attaching to it for a moment.
const consoleText = (pid) =>
  powershell(
    `Add-Type -Namespace Studio -Name Screen -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct Coord { public short X; public short Y; }
[StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left; public short Top; public short Right; public short Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size; public Coord Cursor; public ushort Attributes; public Rect Window; public Coord Largest; }
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out Info info);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacter(IntPtr handle, System.Text.StringBuilder text, uint length, Coord from, out uint read);
'@
[void][Studio.Screen]::FreeConsole()
if (-not [Studio.Screen]::AttachConsole([uint32]$env:QA_PID)) { [IO.File]::WriteAllText($env:QA_OUT, ''); exit }
$screen = [Studio.Screen]::CreateFile('CONOUT$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$info = New-Object 'Studio.Screen+Info'
[void][Studio.Screen]::GetConsoleScreenBufferInfo($screen, [ref]$info)
$lines = for ($row = 0; $row -le $info.Cursor.Y; $row++) {
  $text = New-Object System.Text.StringBuilder ([int]$info.Size.X)
  $from = New-Object 'Studio.Screen+Coord'
  $from.Y = [int16]$row
  $read = [uint32]0
  [void][Studio.Screen]::ReadConsoleOutputCharacter($screen, $text, [uint32]$info.Size.X, $from, [ref]$read)
  $text.ToString(0, [int]$read).TrimEnd()
}
[IO.File]::WriteAllText($env:QA_OUT, ($lines -join [char]10))`,
    { QA_PID: String(pid), QA_OUT: resolve(output, 'screen.txt') },
  );
async function shown(pid) {
  consoleText(pid);
  return (await readFile(resolve(output, 'screen.txt'), 'utf8')).trim();
}
const errorBanner = () =>
  page.evaluate(() => document.querySelector('.error-banner')?.textContent.trim() ?? '');
const fence = (language, ...lines) => ['```' + language, ...lines, '```'].join('\n');
const report = { checkedAt: new Date().toISOString() };
try {
  const installation = await page.invoke('get_installation');
  assert.equal(installation.platform, 'windows');
  await page.waitFor(async () => {
    const workspace = await window.__TAURI_INTERNALS__.invoke('load_workspace');
    return !!workspace?.fleet?.environments?.length;
  });
  // WSL discovery lands shortly after startup; without a distribution that part is skipped.
  let distribution;
  for (let attempt = 0; attempt < 30 && !distribution; attempt++) {
    const { fleet } = await page.invoke('load_workspace');
    distribution = fleet.environments.find(
      (e) => e.platform === 'wsl' && e.discoveredOn === installation.id && e.distribution,
    );
    if (!distribution) await sleep(500);
  }
  if (distribution)
    execFileSync(
      'wsl.exe',
      ['--distribution', distribution.distribution, '--exec', 'mkdir', '-p', '--', linuxFolder],
      { windowsHide: true },
    );
  const now = new Date().toISOString();
  const windowsAnswer = [
    'Run any of these:',
    fence(
      'powershell',
      "$kept = 'state kept'",
      'function prompt { [IO.File]::WriteAllText("$PWD\\ran-powershell.txt", "$((Get-Location).Path)|$kept|$PID"); "PS> " }',
      'Write-Output "powershell says hello"',
    ),
    fence('cmd', 'rem console qa ñ', 'echo cmd says hello', '<nul set /p "=%CD%" > ran-cmd.txt'),
    fence(
      'bash',
      "export KEPT='state kept'",
      'export PROMPT_COMMAND=\'printf "%s|%s|%s" "$(cygpath -w "$PWD")" "$KEPT" "$(cat /proc/$$/winpid)" > ran-bash.txt\'',
      'echo "bash says hello"',
      'set -e',
      'false',
      'echo not reached',
    ),
    // A right-to-left override would show other text than what runs.
    fence('powershell', `Write-Output "${String.fromCharCode(0x202e)}gnp.exe"`),
  ].join('\n\n');
  const chats = (workspace) => {
    const fleet = workspace.fleet;
    const connectionIn = (environmentId) => {
      const existing = fleet.connections.find(
        (c) =>
          c.environmentId === environmentId &&
          ['claude', 'codex'].includes(fleet.accounts.find((a) => a.id === c.accountId)?.provider),
      );
      if (existing) return existing;
      const account = {
        id: crypto.randomUUID(),
        name: 'Console QA',
        provider: 'codex',
        purpose: 'work',
      };
      const connection = {
        id: crypto.randomUUID(),
        environmentId,
        accountId: account.id,
        profile: 'existing',
      };
      fleet.accounts.push(account);
      fleet.connections.push(connection);
      return connection;
    };
    const chat = (title, environment, path, text) => {
      const connection = connectionIn(environment.id);
      const provider = fleet.accounts.find((a) => a.id === connection.accountId).provider;
      return {
        id: crypto.randomUUID(),
        title,
        titleStatus: 'fallback',
        createdAt: now,
        updatedAt: now,
        settings: {
          provider,
          model: '',
          reasoning: '',
          instructions: '',
          connectionId: connection.id,
        },
        location: { computerId: environment.computerId, environmentId: environment.id, path },
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'user',
            status: 'complete',
            createdAt: now,
            blocks: [{ type: 'markdown', text: 'How do I run it?' }],
          },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            status: 'complete',
            createdAt: now,
            blocks: [{ type: 'markdown', text }],
          },
        ],
      };
    };
    const host = fleet.environments.find((e) => e.id === installation.id);
    return [
      chat('Console QA Windows', host, project, windowsAnswer),
      chat('Console QA missing folder', host, resolve(output, 'never created'), windowsAnswer),
      ...(distribution
        ? [
            chat(
              'Console QA WSL',
              fleet.environments.find((e) => e.id === distribution.id),
              linuxFolder,
              [
                fence(
                  'bash',
                  "export KEPT='state kept'",
                  'printf \'%s\' "$PWD" > ran-wsl.txt',
                  'echo "wsl says hello"',
                  'exit 3',
                ),
                fence('powershell', 'Write-Output "not for this computer"'),
              ].join('\n\n'),
            ),
          ]
        : []),
    ];
  };
  const open = async (title) => {
    const opened = await page.evaluate(async (title) => {
      document.querySelector('#conversation-tab-history')?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const row = [...document.querySelectorAll('.conversation-item')].find(
        (e) => e.title === title,
      );
      row?.click();
      return !!row;
    }, title);
    if (opened) await page.waitFor(() => document.querySelectorAll('.message').length === 2);
    return opened;
  };
  // A save the app started during startup detection can land after this one, so seed again
  // until the reloaded app lists the chats.
  for (let attempt = 1; ; attempt++) {
    const current = await page.invoke('load_workspace');
    if (!current.conversations.some((c) => c.title === 'Console QA Windows'))
      current.conversations.push(...chats(current));
    await page.invoke('save_workspace', { workspace: current });
    await page.evaluate(() => (window.consoleReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.consoleReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    if (await open('Console QA Windows')) break;
    assert(attempt < 5, 'The seeded chats did not survive the app reload');
    await sleep(2000);
  }
  await sleep(2500);
  assert.equal(await errorBanner(), '');

  const block = (index, selector) =>
    `.message:not(.user) .prose .code-block:nth-of-type(${index}) ${selector}`;
  const run = async (index) => {
    await page.click(block(index, '.code-run'));
    await page.waitFor(
      (run, note) =>
        /^Opened in /.test(document.querySelector(run)?.textContent ?? '') ||
        !!document.querySelector(note),
      block(index, '.code-run'),
      block(index, '.code-note'),
    );
    return page.evaluate(
      (run, note) => ({
        label: document.querySelector(run).textContent,
        note: document.querySelector(note)?.textContent ?? '',
      }),
      block(index, '.code-run'),
      block(index, '.code-note'),
    );
  };
  const marker = async (name) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const text = await readFile(resolve(project, name), 'utf8').catch(() => '');
      if (text) return text;
      assert(Date.now() < deadline, `${name} was never written`);
      await sleep(200);
    }
  };
  const sameFolder = (path) => realpathSync.native(path) === realpathSync.native(project);
  report.shells = await page.evaluate(
    () => document.querySelector('.app-shell').dataset.console ?? '',
  );
  assert.equal(report.shells, 'posix powershell cmd');
  // Every block copies and the shell blocks run: three shells, and the block with a hidden
  // character, which the host refuses.
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.message:not(.user) .prose .code-block')].map((block) =>
        [...block.querySelectorAll('.code-action')]
          .filter((action) => getComputedStyle(action).display !== 'none')
          .map((action) => action.textContent),
      ),
    ),
    [
      ['Run', 'Copy'],
      ['Run', 'Copy'],
      ['Run', 'Copy'],
      ['Run', 'Copy'],
    ],
  );
  // The controls show when the block is hovered.
  const place = await page.evaluate(() => {
    const rect = document
      .querySelector('.message:not(.user) .prose .code-block')
      .getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + 20 };
  });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...place });
  await sleep(400);
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'native-code-blocks.png'), Buffer.from(shot.data, 'base64'));

  // PowerShell: the session that follows the code still has what it defined.
  report.powershell = await run(1);
  assert.deepEqual(report.powershell, { label: 'Opened in PowerShell', note: '' });
  const [powershellFolder, kept, powershellPid] = (await marker('ran-powershell.txt')).split('|');
  assert(sameFolder(powershellFolder), powershellFolder);
  assert.equal(kept, 'state kept');
  report.powershellScreen = await shown(powershellPid);
  // The code is shown first, then its output, then the prompt the code defined.
  assert.match(report.powershellScreen, /\$kept = 'state kept'/);
  assert.match(report.powershellScreen, /powershell says hello\nPS>$/);
  closeConsoles();

  // Command Prompt echoes each command of the batch file, then stays open.
  report.cmd = await run(2);
  assert.deepEqual(report.cmd, { label: 'Opened in Command Prompt', note: '' });
  assert(sameFolder(await marker('ran-cmd.txt')));
  const [prompt] = consoles();
  assert.equal(prompt?.name, 'cmd.exe');
  report.cmdScreen = await shown(prompt.pid);
  assert.match(report.cmdScreen, /cmd says hello/);
  assert.doesNotMatch(report.cmdScreen, /AGENT_STUDIO_CONSOLE=/);
  closeConsoles();

  // Git Bash: `set -e` ends the code, and the shell that follows keeps its exports.
  report.bash = await run(3);
  assert.deepEqual(report.bash, { label: 'Opened in Git Bash', note: '' });
  const [bashFolder, exported, bashPid] = (await marker('ran-bash.txt')).split('|');
  assert(sameFolder(bashFolder), bashFolder);
  assert.equal(exported, 'state kept');
  report.bashScreen = await shown(bashPid);
  assert.match(report.bashScreen, /bash says hello/);
  assert.doesNotMatch(report.bashScreen, /^not reached$/m);
  try {
    execFileSync('taskkill.exe', ['/PID', bashPid, '/T', '/F'], { windowsHide: true });
  } catch {
    // It already closed.
  }
  closeConsoles();

  // Code with a hidden character is refused, and says why below its block.
  report.hidden = await run(4);
  assert.equal(report.hidden.label, 'Run');
  assert.match(report.hidden.note, /hidden character \(U\+202E\), so it was not run/);
  assert.deepEqual(consoles(), []);

  // A chat whose folder is gone opens no console.
  assert(await open('Console QA missing folder'));
  report.missing = await run(1);
  assert.equal(report.missing.label, 'Run');
  assert.match(report.missing.note, /working folder is unavailable/);
  assert.deepEqual(consoles(), []);

  if (distribution) {
    const inside = (...command) =>
      execFileSync('wsl.exe', ['--distribution', distribution.distribution, '--exec', ...command], {
        encoding: 'utf8',
        windowsHide: true,
      });
    assert(await open('Console QA WSL'));
    report.wslShells = await page.evaluate(
      () => document.querySelector('.app-shell').dataset.console ?? '',
    );
    assert.equal(report.wslShells, 'posix');
    // The PowerShell block is not offered in a distribution.
    assert.equal(
      await page.evaluate(
        (selector) => getComputedStyle(document.querySelector(selector)).display,
        block(2, '.code-run'),
      ),
      'none',
    );
    report.wsl = await run(1);
    assert.deepEqual(report.wsl, {
      label: `Opened in ${distribution.distribution}`,
      note: '',
    });
    const deadline = Date.now() + 30_000;
    let ran = '';
    while (!ran) {
      try {
        ran = inside('cat', '--', `${linuxFolder}/ran-wsl.txt`);
      } catch {
        assert(Date.now() < deadline, 'ran-wsl.txt was never written');
        await sleep(300);
      }
    }
    assert.equal(ran, linuxFolder);
    await sleep(1500);
    const [launcher] = consoles();
    assert.equal(launcher?.name, 'wsl.exe');
    report.wslScreen = await shown(launcher.pid);
    assert.match(report.wslScreen, /wsl says hello/);
    closeConsoles();
    assert.equal(
      inside('bash', '-c', 'ls -d /tmp/agent-studio-console.* 2>/dev/null | wc -l').trim(),
      '0',
    );
    inside('rm', '-rf', '--', linuxFolder);
  } else report.wsl = 'skipped: no WSL distribution';

  assert.equal(await errorBanner(), '');
  assert.deepEqual(page.errors, []);
  report.passed = true;
  await writeFile(resolve(output, 'native-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  closeConsoles();
  await page.button('Close window').catch(() => {});
  page.close();
}
// The debugging socket can outlive its close request and keep Node running.
process.exit(0);
