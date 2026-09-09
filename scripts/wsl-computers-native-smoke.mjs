// Native installation/routing checks in an isolated Tauri instance; no provider prompts.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

async function connectNativeQa() {
  const endpoint = 'http://127.0.0.1:9440';
  const version = createRequire(import.meta.url)('@playwright/test/package.json').version;
  if (Number(version.split('.')[1]) < 63) return chromium.connectOverCDP(endpoint);
  // Recent Playwright requires a browserContextId that WebView2 omits on shared workers.
  // Keep the QA connection scoped to supported targets; do not stop or modify those workers.
  const { webSocketDebuggerUrl } = await (await fetch(endpoint + '/json/version')).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const transport = {
    send(message) {
      if (message.method === 'Target.setAutoAttach') {
        message.params.filter = [
          { type: 'shared_worker', exclude: true },
          ...(message.params.filter ?? [
            { type: 'browser', exclude: true },
            { type: 'tab', exclude: true },
            {},
          ]),
        ];
      }
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener('message', (event) => transport.onmessage?.(JSON.parse(event.data)));
  socket.addEventListener('close', () => transport.onclose?.());
  return chromium.connectOverCDP(transport);
}
const browser = await connectNativeQa();
let restore;
let cleanupSignIn;
const powershell = (script) =>
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes('1420'));
  if (!page) throw new Error('Start the isolated WSL Computers QA app first.');
  page.setDefaultTimeout(20000);
  await page.reload();
  const invoke = (command, args) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  expect(await invoke('plugin:app|identifier')).toBe('com.vinicius.agentstudio.wsl-computers-qa');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.fleet-page')).not.toContainText('Checking installation…', {
    timeout: 60000,
  });
  await expect(page.locator('.fleet-page')).not.toContainText('Checking WSL…', { timeout: 60000 });
  await expect(page.getByText('Checking login…', { exact: true })).toHaveCount(0, {
    timeout: 60000,
  });
  await mkdir('artifacts', { recursive: true });
  const workspace = await invoke('load_workspace');
  restore = async () => {
    await invoke('save_workspace', { workspace });
    await page.reload();
    expect(await invoke('load_workspace')).toEqual(workspace);
  };
  const installation = await invoke('get_installation');
  const distributions = workspace.fleet.environments.filter(
    (e) => e.discoveredOn === installation.id,
  );
  expect(distributions.length).toBeGreaterThan(0);
  const native = page
    .locator('.fleet-computer')
    .filter({ has: page.getByRole('button', { name: /^Manage computer / }) });
  await expect(page.locator('.environment-row, .provider-setup, .connection-copy')).toHaveCount(0);
  await expect(page.getByText('CLI setup', { exact: true })).toHaveCount(0);
  await expect(native.getByRole('button', { name: 'Open sign-in', exact: true })).toHaveCount(3);
  let accountUsage;
  if (process.argv.includes('--usage')) {
    await expect(native.locator('.account-usage')).toHaveCount(3);
    await expect(native.getByText('Checking…', { exact: true })).toHaveCount(0, { timeout: 90000 });
    await expect(native.locator('.account-usage[aria-busy="true"]')).toHaveCount(0, {
      timeout: 90000,
    });
    accountUsage = [];
    for (const provider of ['Codex', 'Claude', 'Gemini']) {
      const card = native.getByRole('article', { name: provider + ' connections', exact: true });
      const usage = card.getByRole('region', {
        name: 'Usage for ' + provider + ' CLI login',
        exact: true,
      });
      await expect(usage).toBeVisible();
      const windows = await usage.getByRole('progressbar').evaluateAll((meters) =>
        meters.map((meter) => ({
          label: meter.getAttribute('aria-label'),
          percent: meter.getAttribute('aria-valuenow'),
        })),
      );
      expect(windows.length).toBeGreaterThanOrEqual(provider === 'Codex' ? 1 : 2);
      if (provider === 'Codex')
        expect(windows.some((w) => w.label === '5-hour limit used' && w.percent == null)).toBe(
          false,
        );
      if (provider === 'Codex' || provider === 'Claude')
        expect(windows.some((w) => w.percent != null)).toBe(true);
      accountUsage.push({
        provider,
        windows,
        status: await usage.locator('.reading-status').innerText(),
      });
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({
        path: `artifacts/account-usage-${provider.toLowerCase()}-native.png`,
      });
    }
    const positions = await native
      .locator('.provider-group')
      .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().top));
    expect(positions[1]).toBeGreaterThan(positions[0]);
    expect(positions[2]).toBeGreaterThan(positions[1]);
    // Four concurrent read-only requests exceed the three-process limit; the fourth must queue.
    const probes = ['codex', 'claude', 'gemini', 'codex'].map((provider) => {
      const connection = workspace.fleet.connections.find(
        (c) =>
          c.environmentId === installation.id &&
          c.profile === 'existing' &&
          workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
      );
      expect(connection).toBeDefined();
      return invoke('read_usage', {
        provider,
        model: '',
        force: true,
        connectionId: connection.id,
      });
    });
    const queuedReadings = await Promise.all(probes);
    expect(queuedReadings.every((reading) => Array.isArray(reading.windows))).toBe(true);
  }
  const results = [];
  for (const environment of distributions) {
    const card = page.getByRole('article', { name: environment.name + ' computer', exact: true });
    await expect(card.locator('.environment-row')).toHaveCount(0);
    const entries = await invoke('inspect_environment_clis', { environmentId: environment.id });
    for (const entry of entries) {
      const provider = entry.id === 'codex' ? 'Codex' : entry.id === 'claude' ? 'Claude' : 'Gemini';
      const inventory = card.getByLabel(provider + ' installation in ' + environment.name);
      await expect(inventory.locator('strong')).toHaveText(
        entry.path ? 'Installed' : 'Not installed',
      );
      if (entry.path) await expect(inventory).toContainText(entry.path);
    }
    const installed = entries.some((entry) => entry.path && entry.id !== 'gemini');
    if (installed) {
      await card.getByRole('button', { name: 'Add account', exact: true }).click();
      await expect(
        page.getByRole('combobox', { name: 'Account purpose', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('dialog')).toContainText(environment.name);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
      await expect(card.getByRole('button', { name: 'Add account', exact: true })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Connect account', exact: true })).toHaveCount(
        0,
      );
      for (const button of await card
        .getByRole('button', { name: 'Open sign-in', exact: true })
        .all())
        await expect(button).toBeDisabled();
    }
    await card.screenshot({ path: `artifacts/wsl-computer-${environment.id}-native.png` });
    results.push({ distribution: environment.distribution, entries });
  }
  await expect(page.locator('select')).toHaveCount(0);
  await mkdir('artifacts', { recursive: true });
  await page.locator('.page-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: 'artifacts/wsl-computers-native.png' });
  await page.locator('.brand').click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const desktopName = workspace.fleet.computers.find((c) => c.id === installation.computerId).name;
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: desktopName, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    desktopName,
  );
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder environment' }).click();
  await page.getByRole('option', { name: distributions[0].name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    desktopName,
  );
  await expect
    .poll(async () => (await invoke('load_workspace')).preferences.recentLocations[0])
    .toMatchObject({
      environmentId: distributions[0].id,
      executionEnvironmentId: installation.id,
    });
  const nativeWorkspace = await invoke('load_workspace');
  const nativeConnection = nativeWorkspace.fleet.connections.find(
    (c) =>
      c.environmentId === installation.id &&
      c.profile === 'existing' &&
      nativeWorkspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === 'codex'),
  );
  expect(nativeConnection).toBeDefined();
  const windowsStatus = await invoke('detect_connection', {
    provider: 'codex',
    connectionId: nativeConnection.id,
  });
  expect(windowsStatus.installed).toBe(true);
  expect(windowsStatus.location).toBe('Windows');
  await page.screenshot({ path: 'artifacts/desktop-wsl-folder-native.png' });
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: distributions[0].name, exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Folder environment' })).toHaveText(
    distributions[0].name,
  );
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect
    .poll(async () => {
      const location = (await invoke('load_workspace')).preferences.recentLocations[0];
      return location.executionEnvironmentId ?? location.environmentId;
    })
    .toBe(distributions[0].id);
  const linuxWorkspace = await invoke('load_workspace');
  expect(linuxWorkspace.preferences.recentLocations[0].executionEnvironmentId).toBeUndefined();
  const linuxConnection = linuxWorkspace.fleet.connections.find(
    (c) =>
      c.environmentId === distributions[0].id &&
      c.profile === 'existing' &&
      linuxWorkspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === 'codex'),
  );
  expect(linuxConnection).toBeDefined();
  const linuxStatus = await invoke('detect_connection', {
    provider: 'codex',
    connectionId: linuxConnection.id,
  });
  const linuxCodex = results[0].entries.find((entry) => entry.id === 'codex');
  expect(linuxStatus.installed).toBe(!!linuxCodex.path);
  if (linuxCodex.path) expect(linuxStatus.location).toBe(distributions[0].name);
  if (results[0].entries.every((entry) => !entry.path || entry.id === 'gemini')) {
    await page.getByLabel('Message', { exact: true }).fill('Unsent routing verification draft');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.screenshot({ path: 'artifacts/wsl-missing-cli-native.png' });
    await page.getByLabel('Message', { exact: true }).fill('');
  }
  expect(linuxWorkspace.conversations).toEqual(workspace.conversations);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(native.locator('.fleet-account')).toHaveCount(3);
  await expect(native.getByText('Checking…', { exact: true })).toHaveCount(0, { timeout: 60000 });
  await expect(native.locator('.fleet-account-heading small')).toHaveCount(0);
  await expect(
    native.locator('.fleet-account').getByText('Connected', { exact: true }),
  ).toHaveCount(0);
  for (const button of await native
    .locator('.fleet-account')
    .getByRole('button', { name: 'Open sign-in', exact: true })
    .all())
    await expect(button).toBeVisible();
  await native.screenshot({ path: 'artifacts/connections-simplified-native.png' });
  const codexCard = native.getByRole('article', { name: 'Codex connections', exact: true });
  await codexCard.screenshot({ path: 'artifacts/provider-card-organized-native.png' });
  await native
    .locator('.fleet-account')
    .first()
    .getByRole('button', { name: 'Manage account', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Edit account purpose' })).toHaveCount(0);
  const management = page.getByRole('dialog', { name: 'Manage account', exact: true });
  await expect(management).toBeVisible();
  await expect(native.locator('input')).toHaveCount(0);
  await expect(
    management.getByRole('button', { name: 'Connect on ' + desktopName, exact: true }),
  ).toHaveCount(0);
  await management.screenshot({ path: 'artifacts/account-management-native.png' });
  await management.getByRole('button', { name: 'Cancel', exact: true }).click();
  let secondAccount;
  if (process.argv.includes('--second-account')) {
    const beforeAddition = await invoke('load_workspace');
    const original = beforeAddition.fleet.connections.find(
      (connection) =>
        connection.environmentId === installation.id &&
        connection.profile === 'existing' &&
        beforeAddition.fleet.accounts.some(
          (account) => account.id === connection.accountId && account.provider === 'claude',
        ),
    );
    expect(original).toBeDefined();
    const originalAccount = beforeAddition.fleet.accounts.find(
      (account) => account.id === original.accountId,
    );
    const appProcesses = JSON.parse(
      powershell(
        "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agent-studio.exe' -and $_.ExecutablePath -like '*\\artifacts\\native-federation-target\\debug\\agent-studio.exe' } | Select-Object ProcessId) | ConvertTo-Json -Compress",
      ),
    );
    const apps = [appProcesses].flat();
    expect(apps).toHaveLength(1);
    const appPid = apps[0].ProcessId;
    const shells = () => {
      const output = powershell(
        `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${appPid} -and $_.Name -eq 'powershell.exe' } | Select-Object ProcessId) | ConvertTo-Json -Compress`,
      ).trim();
      return output ? [JSON.parse(output)].flat().map((p) => p.ProcessId) : [];
    };
    const existingShells = shells();
    cleanupSignIn = () => {
      for (const pid of shells().filter((pid) => !existingShells.includes(pid))) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {}
      }
    };
    await native.getByRole('button', { name: 'Add account', exact: true }).click();
    const accountDialog = page.getByRole('dialog', { name: 'Add account', exact: true });
    await expect(accountDialog.getByRole('combobox', { name: 'Account provider' })).toHaveText(
      'Claude',
    );
    await expect(accountDialog.getByRole('combobox')).toHaveCount(1);
    await expect(accountDialog.getByRole('combobox', { name: 'Login profile' })).toHaveCount(0);
    await expect(accountDialog.getByRole('combobox', { name: 'Account to connect' })).toHaveCount(
      0,
    );
    await expect(accountDialog).not.toContainText('already connected');
    const secondName = 'Second Claude account QA';
    await accountDialog
      .getByRole('textbox', { name: 'Account name', exact: true })
      .fill(secondName);
    await accountDialog.screenshot({ path: 'artifacts/second-account-dialog-native.png' });
    await accountDialog.getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(accountDialog).toHaveCount(0, { timeout: 60000 });
    expect(shells().filter((pid) => !existingShells.includes(pid))).toHaveLength(1);
    const after = await invoke('load_workspace');
    const addedAccount = after.fleet.accounts.find((account) => account.name === secondName);
    expect(addedAccount).toBeDefined();
    const addedConnection = after.fleet.connections.find(
      (connection) => connection.accountId === addedAccount.id,
    );
    expect(addedConnection).toMatchObject({ environmentId: installation.id, profile: 'isolated' });
    expect(after.fleet.connections.find((connection) => connection.id === original.id)).toEqual(
      original,
    );
    expect(after.fleet.accounts.find((account) => account.id === original.accountId)).toEqual(
      originalAccount,
    );
    const addedStatus = await invoke('detect_connection', {
      provider: 'claude',
      connectionId: addedConnection.id,
    });
    expect(addedStatus.installed).toBe(true);
    expect(addedStatus.auth).toBe('login');
    const originalStatus = await invoke('detect_connection', {
      provider: 'claude',
      connectionId: original.id,
    });
    expect(originalStatus.auth).toBe('ready');
    const addedCard = native.locator('.fleet-account').filter({ hasText: secondName });
    await expect(
      addedCard.getByRole('button', { name: 'Open sign-in', exact: true }),
    ).toBeEnabled();
    await addedCard.screenshot({ path: 'artifacts/second-account-awaiting-sign-in-native.png' });
    cleanupSignIn();
    await expect
      .poll(() => shells().filter((pid) => !existingShells.includes(pid)))
      .toHaveLength(0);
    await addedCard.getByRole('button', { name: 'Open sign-in', exact: true }).click();
    await expect(
      addedCard.getByRole('button', { name: 'Open sign-in', exact: true }),
    ).toBeEnabled();
    expect(shells().filter((pid) => !existingShells.includes(pid))).toHaveLength(1);
    expect((await invoke('load_workspace')).fleet).toEqual(after.fleet);
    secondAccount = {
      profile: addedConnection.profile,
      auth: addedStatus.auth,
      originalAuth: originalStatus.auth,
      signInTerminalRunning: true,
      openSignInReopensSameProfile: true,
    };
  }
  expect(errors).toEqual([]);
  const result = {
    checkedAt: new Date().toISOString(),
    results,
    separateComputerSelection: true,
    desktopWslFolderUsesWindows: windowsStatus.installed && windowsStatus.location === 'Windows',
    wslCodexInstalled: linuxStatus.installed,
    noCrossComputerFallback: true,
    simplifiedComputerCards: true,
    signInVisibleWithoutExpanding: true,
    managementInDialog: true,
    ...(secondAccount ? { secondAccount } : {}),
    ...(accountUsage ? { accountUsage, concurrentUsageReads: 4 } : {}),
    workspacePreserved: true,
    rendererErrors: errors,
  };
  await writeFile('artifacts/wsl-computers-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (cleanupSignIn) cleanupSignIn();
  if (restore) await restore();
  await browser.close();
}
