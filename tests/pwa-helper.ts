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
  await signInPwa(page, token);
}

export async function signInPwa(page: Page, token: string) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveCount(0);
  await page.getByLabel('Workspace key', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toHaveCount(0);
}
