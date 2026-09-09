// Opt-in: native WSL metadata inspection, using only the Context QA app and fixture folder.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9447);
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.context-qa');
  const workspace = await page.invoke('load_workspace');
  const fixture = workspace.conversations.findLast((c) => c.title.startsWith('Context QA'));
  assert(fixture && fixture.location.path.includes('context-native'));
  const identity = await page.invoke('get_installation');
  const inventory = await page.invoke('discover_wsl');
  const distro = inventory.distributions.find((d) => d.name === 'Ubuntu');
  assert(distro, 'This opt-in fixture requires Ubuntu.');
  if (!workspace.fleet.environments.some((e) => e.id === distro.id))
    workspace.fleet.environments.push({
      id: distro.id,
      computerId: identity.computerId,
      name: 'WSL · Ubuntu',
      platform: 'wsl',
      distribution: 'Ubuntu',
      discoveredOn: identity.id,
    });
  const path = fixture.location.path
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
  const location = { computerId: identity.computerId, environmentId: distro.id, path };
  const results = [];
  for (const profile of ['existing', 'isolated']) {
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: `WSL context QA ${profile}`,
      provider: 'codex',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: distro.id,
      profile,
    });
    await page.invoke('save_workspace', { workspace });
    if (profile === 'isolated') {
      const status = await page.invoke('detect_connection', { provider: 'codex', connectionId });
      if (!status.installed) {
        const rejected = await page.evaluate(
          async (args) => {
            try {
              await window.__TAURI_INTERNALS__.invoke('read_context', args);
              return false;
            } catch (e) {
              return String(e).includes('CLI was not found in Ubuntu');
            }
          },
          { provider: 'codex', model: 'gpt-5.6-sol', connectionId, location },
        );
        assert(rejected, 'Missing Linux CLI must never fall back to a Windows account.');
        results.push({
          profile,
          available: false,
          fallbackPrevented: true,
          reason:
            'Linux Codex CLI is not installed in Ubuntu; Linux metadata inspection remains unverified.',
        });
        console.log('WSL isolated: missing Linux CLI rejected without Windows fallback.');
        continue;
      }
    }
    const result = await page.invoke('read_context', {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      connectionId,
      location,
    });
    assert.equal(result.execution, profile === 'existing' ? 'Windows' : 'WSL · Ubuntu');
    assert(result.entries.some((e) => e.name === 'AGENTS.md' && e.path.includes('context-native')));
    assert(result.entries.some((e) => e.kind === 'skills' && e.status === 'reported'));
    assert(!result.notes.some((n) => /query failed/.test(n)));
    if (profile === 'isolated') {
      assert(result.profile.includes(connectionId));
      assert(!result.profile.includes('\\'));
      assert.equal(result.folder, path);
      assert(!result.entries.some((e) => e.kind === 'memories'));
    } else assert.equal(result.folder.toLowerCase(), fixture.location.path.toLowerCase());
    results.push({
      profile,
      execution: result.execution,
      instructions: result.entries.filter((e) => e.kind === 'instructions').length,
      skills: result.entries.filter((e) => e.kind === 'skills').length,
      profileIsolated: profile === 'isolated',
      errors: false,
    });
    console.log(`WSL ${profile}: real ${result.execution} context inspection passed.`);
  }
  await writeFile(
    'artifacts/context-wsl-native-result.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  );
} finally {
  page.close();
}
