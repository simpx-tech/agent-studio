// Against the isolated, already-seeded native desktop notification QA app.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9498);
assert.equal(
  await page.invoke('plugin:app|identifier'),
  'com.vinicius.agentstudio.desktop-notifications-qa',
);
const initial = await page.invoke('desktop_notification_settings');
assert(initial.enabled && initial.sound && !initial.lastError);
await page.button('Connections');
await page.waitFor(() => document.querySelector('#notifications-heading'));
await page.evaluate(() =>
  document.querySelector('#notifications-heading').scrollIntoView({ block: 'center' }),
);
await page.waitFor(() =>
  [...document.querySelectorAll('label')].some((e) =>
    e.textContent.includes('Play the Agent Studio chime'),
  ),
);
await page.evaluate(() =>
  [...document.querySelectorAll('label')]
    .find((e) => e.textContent.includes('Play the Agent Studio chime'))
    .querySelector('input')
    .click(),
);
await page.waitFor(
  () =>
    [...document.querySelectorAll('label')]
      .find((e) => e.textContent.includes('Play the Agent Studio chime'))
      .querySelector('input').disabled === false,
);
assert.equal((await page.invoke('desktop_notification_settings')).sound, false);
await page.button('Send test notification');
await page.waitFor(() => document.body.textContent.includes('Test sent.'));
const muted = await page.invoke('desktop_notification_settings');
assert(muted.lastSent > initial.lastSent && !muted.lastError);
await page.button('Disable notifications');
await page.waitFor(() => document.body.textContent.includes('Off on this computer'));
await page.invoke('desktop_notification', {
  notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` },
});
assert.equal((await page.invoke('desktop_notification_settings')).lastSent, muted.lastSent);
await page.cdp('Page.reload');
await page.waitFor(
  () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
);
const restored = await page.invoke('desktop_notification_settings');
assert(!restored.enabled && !restored.sound);
assert.equal(restored.lastSent, muted.lastSent, 'Saved history must not notify on reload.');
await page.invoke('set_desktop_notifications', { enabled: true, sound: true });
await page.button('Connections');
await page.waitFor(() => document.querySelector('#notifications-heading'));
await page.evaluate(() =>
  document.querySelector('#notifications-heading').scrollIntoView({ block: 'center' }),
);
const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
await writeFile('artifacts/desktop-notifications-controls.png', Buffer.from(shot.data, 'base64'));
await page.invoke('plugin:window|minimize', { label: 'main' });
const workspace = await page.invoke('load_workspace');
const notice = {
  kind: 'attention',
  conversationId: workspace.conversations[0].id,
  tag: `${crypto.randomUUID()}:attention`,
};
await page.invoke('desktop_notification', { notice });
const minimized = await page.invoke('desktop_notification_settings');
assert(minimized.lastSent > restored.lastSent && !minimized.lastError);
await writeFile(
  'artifacts/desktop-notifications-controls.json',
  JSON.stringify(
    {
      enabled: true,
      sound: true,
      mutedDelivery: true,
      disabledDeliverySuppressed: true,
      preferencesSurviveReload: true,
      noHistoryReplay: true,
      minimizedDelivery: true,
      rendererErrors: page.errors,
    },
    null,
    2,
  ),
);
assert.deepEqual(page.errors, []);
console.log('Native notification controls, mute, disable, reload and minimized delivery passed.');
page.close();
