import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('late catalogs cannot cross agent selections and a failed discovery preserves the draft', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.evaluate(() => {
    (window as any).holdContext = true;
    (window as any).enableSkill = true;
  });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/');
  await expect.poll(() => page.evaluate(() => (window as any).contextCalls?.length ?? 0)).toBe(1);
  await page.evaluate(() => {
    (window as any).oldRelease = (window as any).releaseContext;
    (window as any).holdContext = false;
  });
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  await input.fill('/fixture');
  await expect(page.getByRole('option', { name: '/fixture:review', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).oldRelease());
  await input.fill('/test');
  await expect(page.getByRole('option', { name: '/test-skill', exact: true })).toHaveCount(0);
  await input.fill('');
  await page.evaluate(() => {
    (window as any).failContext = true;
  });
  await input.fill('/not-discovered arguments');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not refresh commands');
  await expect(input).toHaveValue('/not-discovered arguments');
  await expect(page.locator('.message')).toHaveCount(0);
});

test('slash suggestions support keyboard completion, exact skill identity, arguments and restored history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.evaluate(() => {
    (window as any).enableSkill = true;
  });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/test');
  await expect(page.getByRole('option', { name: '/test-skill', exact: true })).toBeVisible();
  const popup = await page.getByRole('listbox', { name: /Commands and skills/ }).boundingBox();
  const field = await input.boundingBox();
  expect(popup!.y + popup!.height).toBeLessThan(field!.y);
  await input.press('Tab');
  await expect(input).toHaveValue('/test-skill ');
  await expect(page.getByRole('listbox', { name: /Commands and skills/ })).toHaveCount(0);
  await input.press('End');
  await input.pressSequentially('check the arguments');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages?.at(-1)?.skills,
    ),
  ).toEqual([{ name: 'test-skill', path: 'C:\\Profiles\\skills\\test-skill\\SKILL.md' }]);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Skill complete' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.locator('.message.user')).toContainText('/test-skill check the arguments');
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.message.user')).toContainText('/test-skill check the arguments');
});

test('app shortcuts preserve the draft, Escape dismisses, unknown commands do not create a chat, and mobile suggestions fit', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/');
  await expect(page.getByRole('option', { name: '/usage', exact: true })).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: /Commands and skills/ })).toHaveCount(0);
  await input.fill('/unknown-command argument');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(input).toHaveValue('/unknown-command argument');
  await expect(page.locator('.message')).toHaveCount(0);
  await input.fill('/model keep this draft');
  await input.press('Home');
  await input.press('ArrowRight');
  await input.selectText(); // Selection only affects the caret; submission executes the exact command.
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(input).toHaveValue('keep this draft');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('/');
  const list = page.getByRole('listbox', { name: /Commands and skills/ });
  await expect(list).toBeVisible();
  await page.screenshot({ path: 'artifacts/slash-commands-mobile.png' });
  const bounds = await list.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.getByRole('option', { name: '/usage', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Close usage details', exact: true }),
  ).toBeVisible();
});

test('Claude native command names and arguments pass through while disabled skills and session operations stay absent', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/fixture');
  await expect(page.getByRole('option', { name: '/fixture:review', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('/fixture:review ');
  await expect(page.locator('.message')).toHaveCount(0);
  await input.press('End');
  await input.pressSequentially('src/file.ts');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Native command complete' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.locator('.message.user')).toContainText('/fixture:review src/file.ts');
});
