// Run against a fresh isolated defaults QA app, then restart it and pass "restored".
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const id = 'com.vinicius.agentstudio.notification-defaults-qa';
const page = await nativePage(9499);
try {
  assert.equal(await page.invoke('plugin:app|identifier'), id);
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const initial = await page.invoke('desktop_notification_settings');
  const settingsPath = join(process.env.LOCALAPPDATA, id, 'desktop-notifications.json');
  const resultPath = 'artifacts/notification-defaults-native.json';
  if (process.argv[2] === 'restored') {
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert(!initial.enabled && !initial.sound && !initial.lastError);
    assert.equal(initial.lastSent, result.lastSent);
    await page.invoke('desktop_notification', {
      notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` },
    });
    assert.equal((await page.invoke('desktop_notification_settings')).lastSent, result.lastSent);
    await page.button('Connections');
    await page.waitFor(() => document.body.textContent.includes('Off on this computer'));
    result.disabledAndMutedAfterNativeRestart = true;
    result.disabledDeliverySuppressed = true;
    await writeFile(resultPath, JSON.stringify(result, null, 2));
  } else {
    assert(initial.enabled && initial.sound && !initial.lastError && !initial.lastSent);
    await assert.rejects(access(settingsPath), { code: 'ENOENT' });
    await page.button('Connections');
    await page.waitFor(() => document.body.textContent.includes('Enabled on this computer'));
    await page.evaluate(() =>
      document.querySelector('#notifications-heading').scrollIntoView({ block: 'center' }),
    );
    await page.button('Send test notification');
    await page.waitFor(() => document.body.textContent.includes('Test sent.'));
    const sent = await page.invoke('desktop_notification_settings');
    assert(sent.lastSent && !sent.lastError && sent.enabled && sent.sound);
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile('artifacts/notification-defaults-native.png', Buffer.from(shot.data, 'base64'));
    // Save explicit choices for the following full native restart check.
    await page.evaluate(() =>
      [...document.querySelectorAll('label')]
        .find((e) => e.textContent.includes('Play the Agent Studio chime'))
        .querySelector('input')
        .click(),
    );
    await page.waitFor(
      () =>
        ![...document.querySelectorAll('label')]
          .find((e) => e.textContent.includes('Play the Agent Studio chime'))
          .querySelector('input').disabled,
    );
    await page.button('Disable notifications');
    await page.waitFor(() => document.body.textContent.includes('Off on this computer'));
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert(!saved.settings.enabled && !saved.settings.sound);
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          freshInstallEnabled: true,
          customChimeEnabled: true,
          defaultDeliverySucceeded: true,
          lastSent: sent.lastSent,
        },
        null,
        2,
      ),
    );
  }
  assert.deepEqual(page.errors, []);
  console.log(`Native notification defaults ${process.argv[2] ?? 'fresh'} check passed.`);
} finally {
  page.close();
}
