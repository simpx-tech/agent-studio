import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function conversation(page: Page) {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const original = native.invoke;
    native.invoke = async (command: string, args: any) => {
      if (command === 'undo_files') {
        const w = window as any;
        (w.undoCalls ??= []).push(args);
        if (w.undoConflict)
          throw new Error('example.txt has changed since this response. Undo was not applied.');
        return { files: ['example.txt'], undone: args.commit };
      }
      if (command === 'save_workspace' && (window as any).saveFailure) throw new Error('Disk full');
      return original(command, args);
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  for (const prompt of ['First prompt', 'Second prompt']) {
    await input.fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  }
  await expect(page.locator('.message')).toHaveCount(4);
  return input;
}

test('rewind preserves drafts, can be undone after reload, and replaces discarded native context', async ({
  page,
}) => {
  const input = await conversation(page);
  await input.fill('Keep my draft');
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.getByRole('dialog')).toContainText('2 messages');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(input).toHaveValue('Keep my draft');
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await input.fill('Replacement prompt');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.historyRevision).toBe(3);
  expect(request.messages.map((m: any) => m.text)).not.toContain('Second prompt');
  expect(request.messages.at(-1).text).toBe('Replacement prompt');
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toHaveCount(0);
});

test('rewind handles the first message, storage failure, slash commands, and phone layout', async ({
  page,
}) => {
  const input = await conversation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('/rewind');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('combobox', { name: 'Rewind to message' }).click();
  await page.getByRole('option', { name: /1. First prompt/ }).click();
  await expect(page.getByRole('button', { name: 'Rewind', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/rewind/mobile-dialog.png' });
  await page.evaluate(() => ((window as any).saveFailure = true));
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Disk full');
  await expect(page.locator('.message')).toHaveCount(4);
  await page.evaluate(() => ((window as any).saveFailure = false));
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Undo previews host files, requires confirmation, and keeps changed files and history intact on failure', async ({
  page,
}) => {
  await conversation(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    workspace.conversations[0].messages.at(-1).fileChanges = {
      revision: 1,
      limited: false,
      edits: [
        {
          id: 'edit',
          files: [
            {
              path: 'example.txt',
              kind: 'modified',
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ['-before', '+after'],
                },
              ],
            },
          ],
        },
      ],
    };
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'Undo edits', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('example.txt');
  expect(await page.evaluate(() => (window as any).undoCalls.map((c: any) => c.commit))).toEqual([
    false,
  ]);
  await page.screenshot({ path: 'artifacts/rewind/undo-desktop.png' });
  await page.evaluate(() => ((window as any).undoConflict = true));
  await dialog.getByRole('button', { name: 'Undo edits', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('has changed');
  await expect(page.locator('.message')).toHaveCount(4);
  await page.evaluate(() => ((window as any).undoConflict = false));
  await dialog.getByRole('button', { name: 'Undo edits', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('File edits undone', { exact: true })).toBeVisible();
  const workspace = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(workspace.conversations[0].messages.at(-1).filesUndone).toBe(true);
  expect(workspace.conversations[0].historyRevision).toBe(1);
});

test('a retry after rewinding ends Undo rewind so removed messages cannot return out of order', async ({
  page,
}) => {
  await conversation(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const reply = workspace.conversations[0].messages[1];
    reply.status = 'error';
    reply.error = 'The provider stopped unexpectedly.';
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toHaveCount(0);
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0],
  );
  expect(saved.rewind).toBeUndefined();
  expect(saved.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
});
