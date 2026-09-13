import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A clear answer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await dialog.getByRole('button', { name: 'Native prompt', exact: true }).click();
  return dialog;
}

test('native instructions are loaded on demand, remain exact inert text, and never enter saved chat data', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  let dialog = await open(page);
  await expect(dialog).toContainText('Send the first message');
  expect(await page.evaluate(() => (window as any).nativeInstructionCalls ?? [])).toEqual([]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await send(page, 'Native instruction inspection');
  await page.getByLabel('Message', { exact: true }).fill('Unsent follow-up');
  dialog = await open(page);
  const summary = dialog.getByText('Base instructions at session start', { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
  const text =
    'Exact native instruction <script>window.promptExecuted = true</script> & text\nPreserve every line.';
  await expect(dialog.locator('pre:visible')).toHaveText(text);
  expect(await page.evaluate(() => (window as any).promptExecuted)).toBeUndefined();
  await expect(dialog.locator('script')).toHaveCount(0);
  await expect(dialog).toContainText('CLI 0.153.4');
  const requested = await page.evaluate(() => (window as any).nativeInstructionCalls.at(-1));
  const run = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(requested.conversationId).toBe(run.conversationId);
  expect(requested.provider).toBe(run.agent.provider);
  expect(requested.connectionId).toBeTruthy();
  expect(requested).not.toHaveProperty('sessionId');
  expect(requested).not.toHaveProperty('path');
  await page.evaluate(
    () => ((window as any).nativeInstructionText = 'Long native instructions\n'.repeat(1500)),
  );
  await dialog.getByRole('button', { name: 'Refresh native instructions' }).click();
  await expect(dialog.locator('pre:visible')).toContainText('Long native instructions');
  for (const size of [
    { width: 1380, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 460 },
  ]) {
    await page.setViewportSize(size);
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    if (size.width < 700) {
      await dialog.locator('pre:visible').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    }
    await page.screenshot({ path: `artifacts/native-instructions-${size.width}.png` });
  }
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.evaluate(() => ((window as any).failNativeInstructions = true));
  await dialog.getByRole('button', { name: 'Refresh native instructions' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be read');
  await expect(dialog.locator('pre:visible')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent follow-up');
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some(
        (value) =>
          String(value).includes('Exact native instruction') ||
          String(value).includes('Long native instructions'),
      ),
    ),
  ).toBe(false);
});

test('closing a pending native inspection discards its result and an unavailable session stays explicit', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await send(page, 'First native session');
  await page.evaluate(() => {
    (window as any).holdNativeInstructions = true;
    (window as any).nativeInstructionText = 'Old session prompt';
  });
  let dialog = await open(page);
  await expect(dialog).toContainText('Reading the conversation');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => {
    (window as any).holdNativeInstructions = false;
    (window as any).noNativeInstructions = true;
  });
  dialog = await open(page);
  await expect(dialog).toContainText('No native session has been recorded');
  await page.evaluate(() => (window as any).releaseNativeInstructions());
  await expect(dialog).not.toContainText('Old session prompt');
  await expect(dialog.locator('pre:visible')).toHaveCount(0);
  await dialog.getByText('Agent Studio additions · current app version', { exact: true }).click();
  await expect(dialog.locator('pre:visible')).toHaveText(
    'Current Agent Studio guidance supplied as user context.',
  );
  expect(await page.evaluate(() => (window as any).nativeInstructionCalls.length)).toBe(2);
});
