import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

for (const computer of ['Desktop', 'WSL · Ubuntu'])
  test(`a computer alone enables a standalone chat on ${computer}`, async ({ page }) => {
    await mockDesktop(page, 'computer-routing');
    await page.goto('/');
    const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
    if (computer !== 'Desktop') {
      await picker('Computer').click();
      await page.getByRole('option', { name: computer, exact: true }).click();
    }
    await expect(picker('Folder')).toHaveText('Standalone');
    await expect(picker('Agent')).toBeEnabled();
    await expect(picker('Model')).toBeEnabled();
    await picker('Agent').click();
    const provider = computer === 'Desktop' ? 'Claude' : 'Codex';
    if (computer !== 'Desktop')
      await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: provider, exact: true }).click();
    const environmentId =
      computer === 'Desktop'
        ? '11111111-1111-4111-8111-111111111111'
        : '33333333-3333-4333-8333-333333333333';
    await expect
      .poll(() =>
        page.evaluate((environmentId) => {
          const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
          return ((window as any).cliCalls ?? []).some(
            (call: any) =>
              call.command === 'list_models' &&
              workspace.fleet.connections.some(
                (c: any) => c.id === call.connectionId && c.environmentId === environmentId,
              ),
          );
        }, environmentId),
      )
      .toBe(true);
    expect(
      await page.evaluate(() =>
        ((window as any).cliCalls ?? []).filter((c: any) => c.command === 'list_folders'),
      ),
    ).toEqual([]);
    await page.getByLabel('Message', { exact: true }).fill('Run without a project folder');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
    const { workspace, request } = await page.evaluate(() => ({
      workspace: JSON.parse(localStorage.getItem('test-workspace')!),
      request: JSON.parse(localStorage.getItem('test-last-request')!),
    }));
    const chat = workspace.conversations[0];
    expect(chat.location).toEqual({
      computerId: '22222222-2222-4222-8222-222222222222',
      environmentId,
      path: '',
    });
    expect(request.location).toBeUndefined();
    expect(
      workspace.fleet.connections.find((c: any) => c.id === request.agent.connectionId)
        .environmentId,
    ).toBe(environmentId);
    await expect(picker('Folder')).toBeDisabled();
    await expect(picker('Computer')).toBeDisabled();
    await expect(picker('Agent')).toBeDisabled();
  });

test('clearing a draft folder preserves its text and model on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await picker('Model').click();
  await page.getByRole('option', { name: 'Opus', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft when clearing the folder');
  const folderQueries = await page.evaluate(
    () => ((window as any).cliCalls ?? []).filter((c: any) => c.command === 'list_folders').length,
  );
  await picker('Folder').click();
  await page.getByRole('option', { name: 'Standalone', exact: true }).click();
  await expect(picker('Folder')).toHaveText('Standalone');
  await expect(picker('Model')).toHaveText('Opus');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep my draft when clearing the folder',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        ((window as any).cliCalls ?? []).filter((c: any) => c.command === 'list_folders').length,
    ),
  ).toBe(folderQueries);
  await page.screenshot({ path: 'artifacts/standalone-mobile.png' });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});
