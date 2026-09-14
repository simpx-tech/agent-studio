import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9558, 'http://127.0.0.1:1438/');
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.credits-qa');
  await page.waitFor(() => document.querySelector('[aria-label="Connections"]'));
  await page.button('Connections');
  await page.waitFor(() => document.querySelectorAll('.account-usage').length >= 2);
  const workspace = await page.invoke('load_workspace');
  const installation = await page.invoke('get_installation');
  const results = [];
  for (const provider of ['codex', 'claude']) {
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
    assert(connection, `${provider} connection missing`);
    const snapshot = await page.invoke('read_usage', {
      provider,
      model: '',
      force: true,
      connectionId: connection.id,
    });
    assert.equal(snapshot.credits?.kind, provider);
    assert(snapshot.windows.length > 0);
    results.push({
      provider,
      creditFields: Object.keys(snapshot.credits),
      balanceReported: snapshot.credits.balance != null,
      currency: snapshot.credits.currency ?? null,
      enabled: snapshot.credits.enabled ?? null,
    });
  }
  await page.waitFor(() =>
    [...document.querySelectorAll('.credit-usage')].some(
      (c) =>
        /credits/.test(c.textContent) &&
        !/Not reported/.test(c.querySelector('strong').textContent),
    ),
  );
  assert.deepEqual(page.errors, []);
  await mkdir('artifacts/credits', { recursive: true });
  const capture = await page.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile('artifacts/credits/native-connections.png', Buffer.from(capture.data, 'base64'));
  await writeFile(
    'artifacts/credits/native-results.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), results, errors: page.errors }, null, 2),
  );
  console.log('Native read-only credit queries passed for Claude and Codex.');
} finally {
  page.close();
}
