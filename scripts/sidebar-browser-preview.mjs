// Synthetic browser-only visual QA. Never loads native storage or submits provider prompts.
import { chromium, expect } from '@playwright/test';
import { initialWorkspace } from '../src/lib/domain.ts';
import { writeFile } from 'node:fs/promises';

const workspace = initialWorkspace();
const desktop = { id: crypto.randomUUID(), name: 'Desktop QA' };
const laptop = { id: crypto.randomUUID(), name: 'MacBook Pro' };
const windows = {
  id: crypto.randomUUID(),
  computerId: desktop.id,
  name: 'Windows',
  platform: 'windows',
};
const mac = { id: crypto.randomUUID(), computerId: laptop.id, name: 'macOS', platform: 'macos' };
workspace.fleet.computers.push(desktop, laptop);
workspace.fleet.environments.push(windows, mac);
const conversation = (title, environment, path, archived = false) => ({
  id: crypto.randomUUID(),
  title,
  titleStatus: 'generated',
  archived,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
  location: { computerId: environment.computerId, environmentId: environment.id, path },
  messages: [],
});
const first = conversation('Testing the system', windows, 'C:\\Projects\\agent-studio');
const examples = [
  first,
  conversation('Improve folder selection', windows, 'C:\\Projects\\agent-studio'),
  conversation('Review the onboarding flow', windows, 'C:\\Projects\\client-portal'),
  conversation('Plan the next release', mac, '/Users/demo/Projects/website'),
  conversation(
    'Investigate a conversation title that is longer than the sidebar',
    mac,
    '/Users/demo/Projects/website',
  ),
  conversation('Set up the workspace', windows, 'C:\\Projects\\agent-studio', true),
  conversation('Update the landing page', mac, '/Users/demo/Projects/website', true),
];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1380, height: 900 },
  deviceScaleFactor: 1.5,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(
  ({ workspace, installation }) => {
    localStorage.setItem('agent-studio.preview.v1', JSON.stringify(workspace));
    localStorage.setItem('agent-studio.installation', JSON.stringify(installation));
  },
  {
    workspace: { ...workspace, conversations: [first] },
    installation: {
      id: windows.id,
      computerId: desktop.id,
      name: desktop.name,
      platform: 'windows',
    },
  },
);
try {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: first.title, exact: true }).click();
  await page
    .locator('.sidebar')
    .screenshot({ path: 'artifacts/sidebar-single-browser.png', animations: 'disabled' });
  const tabs = await page.locator('.conversation-tabs').boundingBox();
  const panel = await page.locator('#conversation-panel-active').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  await page.screenshot({
    path: 'artifacts/sidebar-hierarchy.png',
    animations: 'disabled',
    clip: {
      x: sidebar.x,
      y: tabs.y - 8,
      width: sidebar.width,
      height: panel.y + panel.height - tabs.y + 24,
    },
  });
  // Same isolated preview; each reload starts from the requested fixture.
  await page.addInitScript((conversations) => {
    const saved = JSON.parse(localStorage.getItem('agent-studio.preview.v1'));
    saved.conversations = conversations;
    localStorage.setItem('agent-studio.preview.v1', JSON.stringify(saved));
  }, examples);
  await page.reload();
  await page.getByRole('button', { name: first.title, exact: true }).click();
  const active = page.locator('#conversation-panel-active');
  await expect(active.locator('.conversation-computer')).toHaveCount(2);
  await expect(active.locator('.conversation-folder')).toHaveCount(3);
  await expect(active.locator('.conversation-item')).toHaveCount(5);
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveText('Active5');
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveText('History2');
  const longTitle = active.locator('.conversation-item').last();
  expect(await longTitle.locator('span').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await page
    .locator('.sidebar')
    .screenshot({ path: 'artifacts/sidebar-multiple-browser.png', animations: 'disabled' });
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(page.locator('#conversation-panel-history .conversation-item')).toHaveCount(2);
  await page
    .locator('.sidebar')
    .screenshot({ path: 'artifacts/sidebar-history-browser.png', animations: 'disabled' });
  await page.getByRole('tab', { name: /^Active/ }).click();
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/sidebar-compact-browser.png', animations: 'disabled' });
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/sidebar-browser-result.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        singleConversation: true,
        multipleComputersAndFolders: true,
        historyTab: true,
        longTitleTruncated: true,
        compactWithoutOverflow: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Sidebar browser preview passed.');
} finally {
  await browser.close();
}
