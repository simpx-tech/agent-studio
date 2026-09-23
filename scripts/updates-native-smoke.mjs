// Native Windows check of signed automatic updates with an isolated QA identity.
//
// Builds three signed NSIS releases of "Agent Studio Update QA" with a throwaway key, serves
// their manifest locally, installs the first through an unpackaged scheduled task, and drives
// the installed app over CDP: background download, Restart to update, a manifest pairing a
// newer version with an older signed package, and installation on an idle close. The QA app
// has its own identifier, product name, executable name, and key, so its installers can never
// close or replace the regular Agent Studio. See docs/UPDATES.md.
//
//   npm run build
//   node scripts/updates-native-smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { nativePage } from './native-page.mjs';
import { verifySignature } from './release.ts';

if (process.platform !== 'win32') throw new Error('This check installs a Windows NSIS package.');
const root = resolve(import.meta.dirname, '..');
const qa = join(root, 'artifacts', 'updates-qa');
const product = 'Agent Studio Update QA';
const binary = 'agent-studio-update-qa';
const identifier = 'com.vinicius.agentstudio.update-qa';
const manifestPort = 1471;
const debugPort = 9541;
const installDir = join(process.env.LOCALAPPDATA, product);
const executable = join(installDir, `${binary}.exe`);
const packages = join(qa, 'packages');
const tauri = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const result = { startedAt: new Date().toISOString(), checks: [] };
const pass = (check) => {
  result.checks.push(check);
  console.log(`ok - ${check}`);
};

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  }).trim();
}
const qaProcesses = () =>
  powershell(`@(Get-Process -Name '${binary}' -ErrorAction SilentlyContinue).Id -join ','`)
    .split(',')
    .filter(Boolean)
    .map(Number);
const installedVersion = () =>
  powershell(
    `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${product}' }).DisplayVersion`,
  ) || undefined;
async function until(check, message, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // The app may be restarting; keep polling until the deadline.
    }
    assert(Date.now() < deadline, message);
    await sleep(500);
  }
}

// One-shot scheduled task under the interactive user's normal token, outside any packaged
// parent's file virtualization, like scripts/start-windows.ps1.
const runner = join(qa, 'run-unpackaged.ps1');
const runnerScript = String.raw`param([Parameter(Mandatory)][string]$FilePath, [string]$Arguments, [Parameter(Mandatory)][string]$ResultPath, [switch]$Inner)
$ErrorActionPreference = 'Stop'
if ($Inner) {
  try {
    if ($Arguments) { $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -Wait }
    else { $process = Start-Process -FilePath $FilePath -PassThru -Wait }
    @{ status = 'done'; exitCode = $process.ExitCode } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 0
  } catch {
    @{ status = 'error'; message = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 1
  }
}
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Hidden = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT5M'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Inner -FilePath "' + $FilePath + '" -ResultPath "' + $ResultPath + '"'
if ($Arguments) { $action.Arguments += ' -Arguments "' + $Arguments + '"' }
$name = 'AgentStudio-UpdateQA-' + [guid]::NewGuid().ToString('N')
$task = $folder.RegisterTaskDefinition($name, $definition, 2, $null, $null, 3)
try {
  $task.Run($null) | Out-Null
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Milliseconds 500
    $task = $folder.GetTask($name)
  } while ($task.State -in @(2, 4) -and (Get-Date) -lt $deadline)
  if (!(Test-Path -LiteralPath $ResultPath)) { throw 'The unpackaged command did not report a result.' }
} finally {
  $folder.DeleteTask($name, 0)
}
`;
function unpackaged(file, args) {
  const output = join(qa, `result-${randomBytes(6).toString('hex')}.json`);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runner,
    '-FilePath',
    file,
    ...(args ? ['-Arguments', args] : []),
    '-ResultPath',
    output,
  ]);
  const value = JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  rmSync(output);
  assert.equal(value.status, 'done', value.message);
  return value;
}

// Builds are cached by version; delete artifacts/updates-qa/packages to rebuild.
function build(version, key, password, pubkey) {
  const name = `${binary}_${version}_x64-setup.exe`;
  const target = join(packages, name);
  if (existsSync(target) && existsSync(`${target}.sig`)) return name;
  const base = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const config = join(qa, `native-updates-${version}.tauri.json`);
  writeFileSync(
    config,
    JSON.stringify({
      productName: product,
      mainBinaryName: binary,
      version,
      identifier,
      build: { beforeBuildCommand: '' },
      app: {
        windows: [
          {
            ...base.app.windows[0],
            title: product,
            additionalBrowserArgs: `--remote-debugging-port=${debugPort}`,
          },
        ],
      },
      plugins: {
        updater: {
          ...base.plugins.updater,
          pubkey,
          endpoints: [`http://127.0.0.1:${manifestPort}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }),
  );
  const status = spawnSync(
    process.execPath,
    [tauri, 'build', '--ci', '--config', config, '--bundles', 'nsis'],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: key,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
        // Update signing and installation do not depend on whole-program optimization.
        CARGO_PROFILE_RELEASE_LTO: 'false',
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
      },
    },
  ).status;
  assert.equal(status, 0, `The ${version} QA build failed.`);
  const built = join(
    root,
    'src-tauri/target/release/bundle/nsis',
    `${product}_${version}_x64-setup.exe`,
  );
  mkdirSync(packages, { recursive: true });
  copyFileSync(built, target);
  copyFileSync(`${built}.sig`, `${target}.sig`);
  return name;
}

async function connect() {
  return until(
    async () => {
      const page = await nativePage(debugPort);
      if (await page.evaluate(() => !!document.querySelector('.sidebar-tools'))) return page;
      page.close();
    },
    'The QA app did not open its window.',
    60_000,
  );
}
async function screenshot(page, name) {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(qa, name), Buffer.from(data, 'base64'));
}
async function settingsText(page) {
  await page.evaluate(() => {
    if (!document.querySelector('#updates-heading'))
      document.querySelector('button[aria-label="Settings"]').click();
  });
  return until(
    () =>
      page.evaluate(
        () => document.querySelector('#updates-heading')?.closest('section')?.innerText,
      ),
    'Settings did not show App updates.',
    15_000,
  );
}

assert.equal(qaProcesses().length, 0, 'Close the running Update QA app before this check.');
assert.equal(installedVersion(), undefined, 'Uninstall the previous Update QA app first.');
mkdirSync(qa, { recursive: true });
writeFileSync(runner, runnerScript);
const keyDir = join(qa, 'keys');
const key = join(keyDir, 'update-qa.key');
const passwordFile = join(keyDir, 'password.txt');
if (!existsSync(key)) {
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(passwordFile, randomBytes(18).toString('base64url'));
  execFileSync(
    process.execPath,
    [tauri, 'signer', 'generate', '--ci', '-w', key, '-p', readFileSync(passwordFile, 'utf8')],
    { stdio: 'ignore' },
  );
}
const pubkey = readFileSync(`${key}.pub`, 'utf8').trim();
const password = readFileSync(passwordFile, 'utf8');
const names = Object.fromEntries(
  ['0.2.0', '0.2.1', '0.2.2'].map((version) => [version, build(version, key, password, pubkey)]),
);
for (const [version, name] of Object.entries(names)) {
  const signed = verifySignature(
    readFileSync(join(packages, name)),
    readFileSync(join(packages, `${name}.sig`), 'utf8'),
    pubkey,
  );
  assert.equal(signed.version, version);
}
pass('bundler signatures carry their version and pass the release verifier');

let manifest;
const server = createServer((request, response) => {
  const file = /^\/packages\/([\w.-]+)$/.exec(request.url ?? '')?.[1];
  if (request.url === '/latest.json' && manifest) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(manifest));
  } else if (file && existsSync(join(packages, file))) {
    const data = readFileSync(join(packages, file));
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': data.length,
    });
    response.end(data);
  } else response.writeHead(404).end();
});
await new Promise((done) => server.listen(manifestPort, '127.0.0.1', done));
// `announced` may differ from the package to simulate a tampered manifest.
function publish(announced, version = announced) {
  const name = names[version];
  const entry = {
    signature: readFileSync(join(packages, `${name}.sig`), 'utf8').trim(),
    url: `http://127.0.0.1:${manifestPort}/packages/${name}`,
  };
  manifest = {
    version: announced,
    notes: `Update QA ${announced}`,
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry },
  };
}

let page;
try {
  unpackaged(join(packages, names['0.2.0']), '/S /NS');
  await until(() => installedVersion() === '0.2.0', 'The 0.2.0 QA install did not finish.');
  pass('installed 0.2.0 through an unpackaged task');

  publish('0.2.1');
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'scripts/start-windows.ps1'),
    '-Executable',
    executable,
  ]);
  page = await connect();
  const first = qaProcesses();
  assert.equal(first.length, 1);
  // The first background check runs 30 seconds after startup.
  await until(
    () =>
      page.evaluate(() => {
        const button = document.querySelector('.sidebar-tools .update-button');
        return !!button && !button.disabled && button.innerText.trim() === 'Restart to update';
      }),
    'The 0.2.1 update was not downloaded.',
  );
  const ready = await settingsText(page);
  assert.match(ready, /Current version 0\.2\.0/);
  assert.match(ready, /Version 0\.2\.1 is ready/);
  await screenshot(page, 'ready.png');
  pass('downloaded and verified 0.2.1 in the background, then offered Restart to update');

  await page.click('.sidebar-tools .update-button');
  page.close();
  await until(() => !qaProcesses().includes(first[0]), 'The 0.2.0 app did not exit.', 30_000);
  await until(() => installedVersion() === '0.2.1', 'The 0.2.1 update was not installed.');
  const relaunched = await until(
    () => qaProcesses().find((id) => id !== first[0]),
    'The updated app did not relaunch.',
    60_000,
  );
  page = await connect();
  assert.match(await settingsText(page), /Current version 0\.2\.1/);
  pass(`Restart to update installed 0.2.1 and relaunched it (process ${relaunched})`);

  // A manifest cannot pair a newer version number with an older signed package.
  publish('0.2.9', '0.2.2');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.innerText.trim() === 'Check for updates')
      .click(),
  );
  const tampered = await until(
    () =>
      page.evaluate(
        () =>
          document
            .querySelector('#updates-heading')
            ?.closest('section')
            ?.querySelector('[role="alert"]')?.innerText,
      ),
    'The tampered manifest was not rejected.',
    60_000,
  );
  assert.match(tampered, /failed signature verification/);
  assert.equal(
    await page.evaluate(() => document.querySelector('.sidebar-tools .update-button')),
    null,
  );
  await screenshot(page, 'tampered.png');
  pass('rejected a manifest announcing 0.2.9 with the 0.2.2 package signature');

  publish('0.2.2');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.innerText.trim() === 'Check for updates')
      .click(),
  );
  await until(
    () =>
      page.evaluate(() => {
        const button = document.querySelector('.sidebar-tools .update-button');
        return !!button && !button.disabled;
      }),
    'The 0.2.2 update was not downloaded.',
    60_000,
  );
  await page.click('button[aria-label="Close window"]');
  page.close();
  page = undefined;
  await until(() => !qaProcesses().length, 'The QA app did not close.', 30_000);
  await until(() => installedVersion() === '0.2.2', 'Closing did not install 0.2.2.');
  // Installing while closing must not reopen the app.
  await sleep(8000);
  assert.deepEqual(qaProcesses(), []);
  pass('closing an idle app installed 0.2.2 without relaunching it');
  result.passed = true;
} finally {
  page?.close();
  server.close();
  for (const id of qaProcesses()) powershell(`Stop-Process -Id ${id} -Force`);
  if (existsSync(join(installDir, 'uninstall.exe'))) {
    unpackaged(join(installDir, 'uninstall.exe'), '/S');
    await until(() => !installedVersion(), 'The QA app was not uninstalled.', 60_000);
  }
  // Remove only this QA identity's own data.
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    const data = join(base, identifier);
    assert(data.endsWith('update-qa'));
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(qa, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
}
