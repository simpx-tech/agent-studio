import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace, type Message } from '../src/lib/domain';
import type { SharedWorkspace } from '../src/lib/sync';
import { seedAndPairPwa } from './pwa-helper';

// The phone shows when a chat a usage limit stopped goes on by itself, and its Cancel reaches the
// computer that would send it, through the relay.
test('the Viewer shows when a stopped chat goes on, and cancels it for its computer', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-auto-continue-'));
  const token = 'synthetic-viewer-auto-continue-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const workspace = initialWorkspace();
    const [computer, environment, account, connection] = Array.from({ length: 4 }, () =>
      crypto.randomUUID(),
    );
    workspace.fleet.computers.push({ id: computer, name: 'Studio PC' });
    workspace.fleet.environments.push({
      id: environment,
      computerId: computer,
      name: 'Windows',
      platform: 'windows',
    });
    workspace.fleet.accounts.push({
      id: account,
      name: 'Work Claude',
      provider: 'claude',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connection,
      environmentId: environment,
      accountId: account,
      profile: 'isolated',
    });
    const settings = {
      connectionId: connection,
      provider: 'claude' as const,
      model: 'opus',
      reasoning: 'max' as const,
      instructions: '',
    };
    const now = Date.now();
    const line = "You've hit your session limit · resets 1:50pm (America/Sao_Paulo)";
    const at = new Date(now + 40 * 60_000);
    const reply: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'error',
      error: line,
      createdAt: new Date(now - 60_000).toISOString(),
      runId: crypto.randomUUID(),
      settings,
      blocks: [{ type: 'activity', text: 'Reading the map.', progress: { id: 'p1', revision: 1 } }],
      usageLimit: { revision: 1, text: line },
      autoContinue: { at: at.toISOString(), changedAt: new Date(now).toISOString() },
    };
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Widen the map',
      titleStatus: 'generated',
      settings,
      location: { computerId: computer, environmentId: environment, path: 'D:\\Projects\\Map' },
      createdAt: reply.createdAt,
      updatedAt: reply.createdAt,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          status: 'complete',
          createdAt: reply.createdAt,
          blocks: [{ type: 'markdown', text: 'Widen the map' }],
        },
        reply,
      ],
    });
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('button', { name: 'Widen the map', exact: true }).click();
    const card = page.locator(`[data-message-id="${reply.id}"] .usage-limit`);
    await expect(card).toContainText(line);
    // The time the computer planned, on the phone's own clock and in its language.
    const plan = card.locator('.usage-limit-continue');
    const shown = await page.evaluate(
      (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      at.toISOString(),
    );
    await expect(plan).toHaveText(new RegExp(`^Continues (\\S+ )?at ${shown}Cancel$`));
    await page.screenshot({ path: 'artifacts/usage-limit-viewer.png' });

    await plan.getByRole('button', { name: 'Cancel continuing' }).click();
    await expect(plan).toHaveCount(0);
    // The relay's copy, which the computer running the chat merges, is off.
    await expect
      .poll(async () => {
        const response = await fetch(`${url}/v1/state`, {
          headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
        });
        const { workspace: shared } = (await response.json()) as { workspace: SharedWorkspace };
        return shared.conversations[0].messages[1].autoContinue?.off;
      })
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
