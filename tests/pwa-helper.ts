import { expect, type Page } from '@playwright/test';
import { sharedWorkspace } from '../src/lib/sync';
import type { Workspace } from '../src/lib/domain';

// Seed real server storage, then obtain the PWA's HttpOnly session through its
// pairing flow. Saved browser data is deliberately not an authentication source.
export async function seedAndPairPwa(page: Page, url: string, token: string, workspace: Workspace) {
  const seeded = await page.request.put(`${url}/v1/state`, {
    headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
    data: { revision: 0, workspace: sharedWorkspace(workspace) },
  });
  expect(seeded.status()).toBe(200);
  await page.goto(url);
  await expect(page.getByRole('tab', { name: /^History/ })).toContainText('0');
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
  await page.getByLabel('Relay pairing key').fill(token);
  await page.getByRole('button', { name: 'Pair & sync' }).click();
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
