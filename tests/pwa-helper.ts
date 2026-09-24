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

// Reads the Viewer's private workspace cache from IndexedDB without creating the database.
export function viewerCache(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, string>>((resolve, reject) => {
        const request = indexedDB.open('agent-studio');
        request.onupgradeneeded = () => request.transaction!.abort();
        request.onerror = () =>
          request.error?.name === 'AbortError' ? resolve({}) : reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const entries: Record<string, string> = {};
          const cursor = database
            .transaction('private-workspaces')
            .objectStore('private-workspaces')
            .openCursor();
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            if (!cursor.result) {
              database.close();
              resolve(entries);
              return;
            }
            entries[String(cursor.result.key)] = cursor.result.value;
            cursor.result.continue();
          };
        };
      }),
  );
}

export async function signInPwa(page: Page, token: string) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveCount(0);
  await page.getByLabel('Workspace key', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toHaveCount(0);
}
