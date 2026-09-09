// Read-only UI check in the existing folder QA app; no prompts or workspace writes.
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9432');
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes('1420'));
  if (!page) throw new Error('Start the folder QA app first.');
  const invoke = (command) =>
    page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
  if ((await invoke('plugin:app|identifier')) !== 'com.vinicius.agentstudio.locations-qa')
    throw new Error('Wrong QA identity.');
  const before = await invoke('load_workspace');
  if (before.conversations.some((c) => c.messages.some((m) => m.status === 'running')))
    throw new Error('Wait for the current response before checking the sidebar.');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const originalTab = await page.getByRole('tab', { selected: true }).getAttribute('id');
  const originalTitle = await page.locator('.page-title').innerText();
  const checkFolderAction = process.argv.includes('--new-chat');
  if (
    checkFolderAction &&
    (await page.getByLabel('Message', { exact: true }).count()) &&
    (await page.getByLabel('Message', { exact: true }).inputValue())
  )
    throw new Error('Preserve the current draft before checking the folder action.');
  const activeTab = page.getByRole('tab', { name: /^Active/ });
  const historyTab = page.getByRole('tab', { name: /^History/ });
  try {
    await activeTab.click();
    await expect(page.locator('#conversation-panel-active')).toBeVisible();
    await activeTab.press('End');
    await expect(historyTab).toBeFocused();
    await expect(page.locator('#conversation-panel-active')).toBeHidden();
    await expect(page.locator('#conversation-panel-history')).toBeVisible();
    await expect(page.locator('.page-title')).toHaveText(originalTitle);
    await historyTab.press('Home');
    await expect(activeTab).toBeFocused();
    await expect(page.locator('#conversation-panel-history')).toBeHidden();
    for (const toggle of await page
      .locator(
        '#conversation-panel-active .computer-group-toggle, #conversation-panel-active .folder-group-toggle',
      )
      .all()) {
      const expanded = await toggle.getAttribute('aria-expanded');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', String(expanded !== 'true'));
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', expanded);
    }
    await page.mouse.move(900, 40);
    await page
      .locator('.sidebar')
      .screenshot({ path: 'artifacts/sidebar-native.png', animations: 'disabled' });
    if (checkFolderAction) {
      const plus = page.locator('#conversation-panel-active .folder-new-chat:visible').first();
      const detail = await plus.locator('..').locator('.folder-group-toggle').getAttribute('title');
      const location = before.conversations
        .map((c) => c.location)
        .find(
          (location) =>
            location?.path &&
            `${before.fleet.environments.find((e) => e.id === location.environmentId)?.name ?? 'Unavailable environment'} · ${location.path}` ===
              detail,
        );
      if (!location) throw new Error('No visible saved folder to verify.');
      const computer = before.fleet.computers.find((c) => c.id === location.computerId);
      await plus.press('Enter');
      await expect(page.locator('.page-title')).toHaveText('New conversation');
      await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
        computer.name,
      );
      await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
        'title',
        location.path,
      );
      await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
      await expect(page.getByTestId('message')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.mouse.move(900, 40);
      await page.screenshot({
        path: 'artifacts/folder-new-chat-native.png',
        animations: 'disabled',
      });
    }
    expect(await invoke('load_workspace')).toEqual(before);
    expect(errors).toEqual([]);
    const result = {
      checkedAt: new Date().toISOString(),
      nativeTabs: true,
      keyboardNavigation: true,
      collapseRestore: true,
      openConversationUnchanged: !checkFolderAction,
      newChatPreselectsComputerAndFolder: checkFolderAction,
      workspaceUnchanged: true,
      providerPromptsSent: 0,
      viewport: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      })),
      errors,
    };
    await writeFile('artifacts/sidebar-native-result.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (originalTab) await page.locator(`#${originalTab}`).click();
    if (checkFolderAction && originalTitle !== 'New conversation') {
      const original = page.getByRole('button', { name: originalTitle, exact: true });
      if ((await original.count()) === 1) await original.click();
    }
  }
} finally {
  await browser.close();
}
