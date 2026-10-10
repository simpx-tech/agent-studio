import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// The desktop fixture's own environment, which keeps the screens.
const desktop = '11111111-1111-4111-8111-111111111111';
const screenId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const digest = 'a'.repeat(64);

// A page that lists pull requests through its action, keeps a filter and asks for a chat.
const html = `<h1>My pull requests</h1>
<p id="status">Loading…</p>
<ul id="prs"></ul>
<button id="save">Save filter</button>
<p id="saved"></p>
<button id="ask">Ask about #12</button>
<p id="asked"></p>
<script>
  const status = document.getElementById('status');
  studio.json('list_prs', { since: '2026-09-28' }).then(
    (prs) => {
      status.textContent = prs.length + ' pull requests';
      for (const pr of prs) {
        const item = document.createElement('li');
        item.textContent = '#' + pr.number + ' ' + pr.title;
        document.getElementById('prs').append(item);
      }
    },
    (error) => (status.textContent = error.message),
  );
  document.getElementById('save').onclick = async () => {
    await studio.save('filter', { state: 'open' });
    const filter = await studio.load('filter');
    document.getElementById('saved').textContent = 'Saved ' + filter.state;
  };
  document.getElementById('ask').onclick = () =>
    studio.chat('Review pull request #12').then(
      () => (document.getElementById('asked').textContent = 'Asked'),
      (error) => (document.getElementById('asked').textContent = error.message),
    );
</script>`;

function screen(conversationId: string, extra: Record<string, unknown> = {}) {
  return {
    id: screenId,
    revision: 1,
    title: 'My pull requests',
    description: 'PRs I opened this week',
    environmentId: desktop,
    project: 'C:\\Projects\\studio',
    folder: 'C:\\Projects\\studio',
    conversationId,
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:00:00.000Z',
    html,
    actions: [
      {
        name: 'list_prs',
        description: 'Lists the pull requests I opened since a day',
        shell: 'powershell',
        script: `gh search prs --author '@me' --created ">=$env:PARAM_SINCE" --json number,title`,
        params: { since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        timeout: 60,
      },
    ],
    digest,
    allowed: false,
    ...extra,
  };
}

/** Sends a message whose reply saves the screen, then ends. */
async function replySavingScreen(page: Page, record: (conversationId: string) => unknown) {
  await chooseTestFolder(page);
  await page
    .getByLabel('Message', { exact: true })
    .fill('Make a page of the pull requests I opened this week');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const conversationId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-last-request')!).conversationId as string,
  );
  await page.evaluate((value) => {
    localStorage.setItem('test-screens', JSON.stringify([value]));
    (window as any).screenOutputs = {
      list_prs: [
        { number: 12, title: 'Add screens' },
        { number: 13, title: 'Fix sync' },
      ],
    };
  }, record(conversationId));
  await page.evaluate(
    ({ id, environmentId }) => {
      const w = window as any;
      w.emitCapability({
        kind: 'screen',
        screen: { id, revision: 1, title: 'My pull requests', environmentId },
      });
      w.emitCapability({
        kind: 'text',
        text: 'I saved **My pull requests**. Open it and allow its action.',
      });
      w.finishCapabilities('complete');
    },
    { id: screenId, environmentId: desktop },
  );
  return conversationId;
}

test('a chat saves a screen that runs only allowed actions, keeps values and starts chats', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await replySavingScreen(page, (conversationId) => screen(conversationId));
  // The reply opens the screen it saved, and the Screens tab lists it waiting for approval.
  const card = page.getByRole('button', { name: 'My pull requests Open screen' });
  await expect(card).toBeVisible();
  await page.screenshot({ path: 'artifacts/screens-reply-card.png' });
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await expect(page.getByRole('tab', { name: /^Screens/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'My pull requests, its actions wait for your approval' }),
  ).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { name: 'My pull requests' })).toBeVisible();
  const frame = page.frameLocator('iframe[title="My pull requests screen"]');
  // Nothing runs before the user allows it; the page hears why.
  await expect(frame.locator('#status')).toContainText('has not allowed this screen’s actions');
  expect(await page.evaluate(() => (window as any).screenRuns ?? [])).toEqual([]);
  await page.getByRole('button', { name: 'Review actions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow screen actions' });
  await expect(dialog.getByText('list_prs')).toBeVisible();
  await expect(dialog.getByText('PARAM_SINCE', { exact: true })).toBeVisible();
  await expect(dialog.locator('.action-script')).toContainText('gh search prs');
  await expect(dialog).toContainText('C:\\Projects\\studio');
  await page.screenshot({ path: 'artifacts/screens-review.png' });
  await dialog.getByRole('button', { name: 'Allow actions' }).click();
  await expect(dialog).toBeHidden();
  // Allowing names exactly the reviewed actions, and the page starts again and runs them.
  expect(
    await page.evaluate(() =>
      (window as any).screenRequests.find((r: { op: string }) => r.op === 'approve'),
    ),
  ).toEqual({ op: 'approve', id: screenId, digest });
  await expect(frame.locator('#status')).toHaveText('2 pull requests');
  await expect(frame.locator('#prs li')).toHaveText(['#12 Add screens', '#13 Fix sync']);
  expect(await page.evaluate(() => (window as any).screenRuns)).toEqual([
    { op: 'run', id: screenId, action: 'list_prs', params: { since: '2026-09-28' } },
  ]);
  await expect(page.getByRole('button', { name: 'Review this screen’s actions' })).toBeVisible();
  await expect(page.getByText('Review before allowing')).toBeHidden();
  // Values the page saves stay with the screen on its computer.
  await frame.getByRole('button', { name: 'Save filter' }).click();
  await expect(frame.locator('#saved')).toHaveText('Saved open');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-screens')!)[0].data),
  ).toEqual({ filter: { state: 'open' } });
  await expect(page.getByRole('button', { name: 'My pull requests', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/screens-allowed.png' });
  // A click in the page opens a new chat in its folder with the text as a draft, never sent.
  const runs = Number(await page.evaluate(() => localStorage.getItem('test-run-count')));
  await frame.getByRole('button', { name: 'Ask about #12' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Review pull request #12');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toContainText('studio');
  expect(Number(await page.evaluate(() => localStorage.getItem('test-run-count')))).toBe(runs);
  // Deleting it removes it from its computer and the list.
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await page.getByRole('button', { name: 'My pull requests', exact: true }).click();
  await page.getByRole('button', { name: 'Delete this screen' }).click();
  await page
    .getByRole('dialog', { name: 'Delete screen' })
    .getByRole('button', { name: 'Delete screen', exact: true })
    .click();
  await expect(page.getByText(/^No screens yet/)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-screens')!))).toEqual([]);
});

test('a screen can neither open chats by itself nor reach undeclared or stale calls', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const probe = `<p id="chat"></p><p id="flood"></p><script>
    studio.chat('Do something').then(() => (document.getElementById('chat').textContent = 'opened'),
      (error) => (document.getElementById('chat').textContent = error.message));
    // Not a call of this frame's bridge: wrong names and tokens are ignored.
    parent.postMessage({ type: 'studio-screen', token: 'guess', id: 99, method: 'run', action: 'list_prs' }, '*');
    parent.postMessage({ type: 'studio-screen', token: 'guess', id: 98, method: 'run', action: 'Remove-Item' }, '*');
    // However many calls wait at once, each reaches the computer.
    for (let call = 0; call < 9; call++)
      studio.run('list_prs', { since: '2026-09-28' }).catch((error) => {
        document.getElementById('flood').textContent += error.message;
      });
  </script>`;
  await replySavingScreen(page, (conversationId) =>
    screen(conversationId, { html: probe, allowed: true }),
  );
  await page.evaluate(() => ((window as any).holdScreenRun = true));
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = page.frameLocator('iframe[title="My pull requests screen"]');
  await expect(frame.locator('#chat')).toHaveText(
    'studio.chat works right after the user clicks or types in the screen.',
  );
  await expect(page.getByLabel('Message', { exact: true })).toBeHidden();
  // Only the bridge's own calls reached the computer, every one of them.
  await expect.poll(() => page.evaluate(() => (window as any).screenRuns?.length)).toBe(9);
  expect(
    await page.evaluate(
      () => (window as any).screenRequests.filter((r: { op: string }) => r.op === 'run').length,
    ),
  ).toBe(9);
  await expect(frame.locator('#flood')).toBeEmpty();
  await expect(page.getByRole('status').filter({ hasText: 'Running list_prs' })).toBeVisible();
});
