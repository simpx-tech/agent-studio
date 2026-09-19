import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('steers the active reply, keeps queue behavior, and restores accepted history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeVisible();
  await input.fill('Check the tests first');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByLabel('Steering messages')).toContainText('Check the tests first');
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  const sent = await page.evaluate(() => (window as any).steeringSent[0]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(sent.runId).toBe(request.runId);
  expect(sent.connectionId).toBe(request.agent.connectionId);
  await input.fill('/some-skill');
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeDisabled();
  await input.fill('Do this afterward');
  await input.press('Enter');
  await expect(page.getByRole('list', { name: 'Queued messages' })).toContainText(
    'Do this afterward',
  );
  await page.screenshot({ path: 'artifacts/steering/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Steer now' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/steering/mobile.png' });
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(input).toHaveValue('Do this afterward');
  await input.fill('Continue');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  const next = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(
    next.messages.some((m: { text: string }) => m.text.includes('Check the tests first')),
  ).toBe(true);
});

test('failed delivery preserves text, and a late confirmation cannot erase a newer draft', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await page.evaluate(() => ((window as any).steeringFailure = true));
  await input.fill('Correction');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(page.getByRole('alert')).toContainText('Your steering was not sent');
  await expect(input).toHaveValue('Correction');
  await expect(page.getByLabel('Steering messages')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).steeringFailure = false;
    (window as any).holdSteering = true;
  });
  await input.fill('New correction');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeDisabled();
  await input.fill('Keep this draft');
  await page.evaluate(() => (window as any).releaseSteering());
  await expect(page.getByLabel('Steering messages')).toContainText('New correction');
  await expect(input).toHaveValue('Keep this draft');
});

test('retry retains the stopped attempt and its accepted steering', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Initial task');
  await input.press('Enter');
  await input.fill('Preserve the existing file');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  await expect(page.getByLabel('Steering messages')).toContainText('Preserve the existing file');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(
    request.messages.some((m: { text: string }) => m.text.includes('Preserve the existing file')),
  ).toBe(true);
  expect(request.messages.at(-1).text).toContain('including my steering');
});
