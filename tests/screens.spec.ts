import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// The desktop fixture's own environment, which keeps the screens.
const desktop = '11111111-1111-4111-8111-111111111111';
const screenId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    document.getElementById('saved').textContent = 'Saved ' + filter.state + ' ' + studio.values.filter.state;
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
      { name: 'build', shell: 'powershell', script: 'dotnet build' },
    ],
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
      w.emitCapability({ kind: 'text', text: 'I saved **My pull requests**.' });
      w.finishCapabilities('complete');
    },
    { id: screenId, environmentId: desktop },
  );
  return conversationId;
}
const frameOf = (page: Page) => page.frameLocator('iframe[title="My pull requests screen"]');
/** The screen's own frame, to run script inside its page. */
async function pageFrame(page: Page) {
  const element = await page.locator('iframe[title="My pull requests screen"]').elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error('No screen frame');
  return frame;
}
const starts = (page: Page) =>
  page.evaluate(() =>
    ((window as any).screenRequests ?? []).filter((r: { op: string }) => r.op === 'start'),
  );

test('a chat saves a screen whose actions run at once, keep values and start chats', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await replySavingScreen(page, (conversationId) => screen(conversationId));
  const card = page.getByRole('button', { name: 'My pull requests Open screen' });
  await expect(card).toBeVisible();
  await page.screenshot({ path: 'artifacts/screens-reply-card.png' });
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await expect(page.getByRole('button', { name: 'My pull requests', exact: true })).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { name: 'My pull requests' })).toBeVisible();
  const frame = frameOf(page);
  // Nothing waits for an approval: the page runs its action as it opens.
  await expect(frame.locator('#status')).toHaveText('2 pull requests');
  await expect(frame.locator('#prs li')).toHaveText(['#12 Add screens', '#13 Fix sync']);
  expect(await starts(page)).toEqual([
    {
      op: 'start',
      id: screenId,
      action: 'list_prs',
      params: { since: '2026-09-28' },
      keep: false,
    },
  ]);
  // A run the page received leaves no job behind.
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as any).screenJobs ?? {}).length))
    .toBe(0);
  // Values the page saves stay with the screen on its computer, and in studio.values.
  await frame.getByRole('button', { name: 'Save filter' }).click();
  await expect(frame.locator('#saved')).toHaveText('Saved open open');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-screens')!)[0].data),
  ).toEqual({ filter: { state: 'open' } });
  await page.screenshot({ path: 'artifacts/screens-open.png' });
  // A page opens a new chat in its folder with the text as a draft, never sent unless asked.
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
  await expect(page.getByText('No screens', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-screens')!))).toEqual([]);
});

test('a screen calls any MCP tool at once, where and as the account it names', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const issues = `<p id="status">Loading…</p><ul id="issues"></ul><p id="answered"></p>
<button id="projects">Projects</button><p id="projects-status"></p>
<script>
  const status = document.getElementById('status');
  studio.mcpJson('linear', 'list_issues', { state: 'open' }).then(
    (result) => {
      status.textContent = result.issues.length + ' issues';
      for (const issue of result.issues) {
        const item = document.createElement('li');
        item.textContent = issue.title;
        document.getElementById('issues').append(item);
      }
    },
    (error) => (status.textContent = error.message),
  );
  studio.mcp('linear', 'get_viewer', {}).then((result) => (document.getElementById('answered').textContent = result.account));
  document.getElementById('projects').onclick = () =>
    studio.mcp('claude.ai Linear', 'list_projects', {}, { where: 'windows', account: 'Work' }).then(
      (result) => (document.getElementById('projects-status').textContent = result.text),
      (error) => (document.getElementById('projects-status').textContent = error.message),
    );
</script>`;
  await replySavingScreen(page, (conversationId) =>
    screen(conversationId, {
      html: issues,
      actions: [],
      mcpTools: [
        {
          server: 'linear',
          tool: 'list_issues',
          description: 'Lists my open issues',
          where: 'wsl',
        },
      ],
      account: { provider: 'claude', connectionId: '' },
    }),
  );
  await page.evaluate(() => {
    (window as any).screenToolResults = {
      list_issues: {
        content: [{ type: 'text', text: '2 issues' }],
        structuredContent: { issues: [{ title: 'Fix sync' }, { title: 'Add tools' }] },
      },
      list_projects: {
        error:
          'Sign in to the MCP server claude.ai Linear for this account first, from MCPs in Model context.',
      },
    };
  });
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = frameOf(page);
  // The declared tool and one it does not declare both answer at once.
  await expect(frame.locator('#status')).toHaveText('2 issues');
  await expect(frame.locator('#issues li')).toHaveText(['Fix sync', 'Add tools']);
  await expect(frame.locator('#answered')).toHaveText('Claude CLI login (Claude)');
  const calls = await page.evaluate(() => (window as any).screenToolCalls);
  expect(calls).toContainEqual({
    op: 'mcp',
    id: screenId,
    server: 'linear',
    tool: 'list_issues',
    arguments: { state: 'open' },
  });
  expect(calls).toContainEqual({
    op: 'mcp',
    id: screenId,
    server: 'linear',
    tool: 'get_viewer',
    arguments: {},
  });
  // A call names its place and account; a tool that cannot be called says why in the page.
  await frame.getByRole('button', { name: 'Projects' }).click();
  await expect(frame.locator('#projects-status')).toHaveText(
    'Sign in to the MCP server claude.ai Linear for this account first, from MCPs in Model context.',
  );
  expect(await page.evaluate(() => (window as any).screenToolCalls.at(-1))).toEqual({
    op: 'mcp',
    id: screenId,
    server: 'claude.ai Linear',
    tool: 'list_projects',
    arguments: {},
    where: 'windows',
    account: 'Work',
  });
  await page.screenshot({ path: 'artifacts/screens-mcp.png' });
});

test('a screen keeps its page while another chat shows, and its run goes on with live output', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const build = `<p id="opened"></p><button id="count">Count</button><p id="counted">0</p>
<button id="build">Build</button><pre id="log"></pre><p id="result"></p>
<script>
  document.getElementById('opened').textContent = 'Opened ' + Math.random();
  let count = 0;
  document.getElementById('count').onclick = () =>
    (document.getElementById('counted').textContent = String(++count));
  document.getElementById('build').onclick = async () => {
    const log = document.getElementById('log');
    const result = await studio.run('build', {}, { onOutput: (text) => (log.textContent += text) });
    document.getElementById('result').textContent = 'Exit ' + result.exitCode;
  };
</script>`;
  await replySavingScreen(page, (conversationId) => screen(conversationId, { html: build }));
  await page.evaluate(() => {
    const w = window as any;
    w.holdScreenRun = true;
    w.screenOutputs.build = 'Build succeeded\n';
  });
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = frameOf(page);
  const opened = await frame.locator('#opened').textContent();
  await frame.getByRole('button', { name: 'Build' }).click();
  await expect.poll(() => starts(page)).toHaveLength(1);
  // Its output reaches the page as it arrives.
  await page.evaluate(() => (window as any).printScreenRun('Compiling 1/2\n'));
  await expect(frame.locator('#log')).toHaveText('Compiling 1/2');
  await expect(page.getByRole('button', { name: 'Jobs, 1 running' })).toBeVisible();
  for (let click = 0; click < 3; click++)
    await frame.getByRole('button', { name: 'Count' }).click();
  await expect(frame.locator('#counted')).toHaveText('3');
  // The chat shows; the screen keeps running out of sight.
  await page.getByRole('button', { name: 'Open the chat that made this screen' }).click();
  await expect(page.getByRole('heading', { name: 'My pull requests' })).toBeHidden();
  await page.evaluate(() => (window as any).printScreenRun('Compiling 2/2\n'));
  await page.evaluate(() => (window as any).releaseScreenRun());
  // Back on the screen, the page is the one it was, with all it printed and counted.
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await page.getByRole('button', { name: 'My pull requests', exact: true }).click();
  await expect(frame.locator('#opened')).toHaveText(opened!);
  await expect(frame.locator('#counted')).toHaveText('3');
  await expect(frame.locator('#log')).toHaveText('Compiling 1/2\nCompiling 2/2\nBuild succeeded');
  await expect(frame.locator('#result')).toHaveText('Exit 0');
  await expect(page.getByRole('button', { name: 'Jobs', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/screens-kept.png' });
});

test('a reopened page finds its jobs, and the Jobs panel follows and stops them', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const jobs = `<button id="build">Build</button><p id="latest"></p><pre id="log"></pre>
<script>
  const show = async (job) => {
    document.getElementById('latest').textContent = job.label + ' ' + job.state;
    const log = document.getElementById('log');
    log.textContent = '';
    const end = await studio.follow(job.id, { onOutput: (text) => (log.textContent += text) });
    document.getElementById('latest').textContent = job.label + (end.stopped ? ' stopped' : ' exit ' + end.exitCode);
  };
  studio.jobs().then((list) => list.length && show(list[0]));
  document.getElementById('build').onclick = async () => show(await studio.start('build', { target: 'Editor' }));
</script>`;
  await replySavingScreen(page, (conversationId) => screen(conversationId, { html: jobs }));
  await page.evaluate(() => ((window as any).holdScreenRun = true));
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = frameOf(page);
  await frame.getByRole('button', { name: 'Build' }).click();
  await expect(frame.locator('#latest')).toHaveText('build running');
  expect((await starts(page)).at(-1)).toMatchObject({
    action: 'build',
    params: { target: 'Editor' },
    keep: true,
  });
  await page.evaluate(() => (window as any).printScreenRun('Step 1\n'));
  await expect(frame.locator('#log')).toHaveText('Step 1');
  // A page that opens again, as after quitting the app, finds the job and follows it.
  await page.getByRole('button', { name: 'Reload this screen' }).click();
  await expect(frame.locator('#latest')).toHaveText('build running');
  await expect(frame.locator('#log')).toHaveText('Step 1');
  // The Jobs panel shows its output as it arrives and stops it.
  await page.getByRole('button', { name: 'Jobs, 1 running' }).click();
  const dialog = page.getByRole('dialog', { name: 'Jobs' });
  await expect(dialog.getByRole('button', { name: /build/ })).toContainText('Running');
  await expect(dialog.getByLabel('Job output')).toHaveText('Step 1\n');
  await page.evaluate(() => (window as any).printScreenRun('Step 2\n'));
  await expect(dialog.getByLabel('Job output')).toHaveText('Step 1\nStep 2\n');
  await page.screenshot({ path: 'artifacts/screens-jobs.png' });
  await dialog.getByRole('button', { name: 'Stop' }).click();
  await expect(dialog.getByRole('button', { name: /build/ })).toContainText('Stopped');
  await expect(frame.locator('#latest')).toHaveText('build stopped');
  // A kept job stays until removed.
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByText('No jobs')).toBeVisible();
  expect(await page.evaluate(() => Object.keys((window as any).screenJobs).length)).toBe(0);
});

test('a page copies, opens links, asks a model and sends chats, but none while hidden', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  // Links the page opens, which the desktop hands to the browser.
  await page.addInitScript(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__?.invoke;
    if (!original) return;
    w.openedLinks = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any, options: any) => {
      if (command === 'plugin:opener|open_url') {
        w.openedLinks.push(args.url);
        return;
      }
      return original(command, args, options);
    };
  });
  await page.goto('/');
  const tools = `<button id="copy">Copy</button><button id="open">Open</button>
<button id="ask">Ask</button><button id="exec">Exec</button><button id="send">Send</button>
<p id="said"></p>
<script>
  const said = (text) => (document.getElementById('said').textContent = text);
  document.getElementById('exec').onclick = () =>
    studio.exec('gh pr list', { where: 'wsl', params: { limit: 5 } }).then((result) => said(result.stdout.trim()));
  document.getElementById('copy').onclick = () => studio.copy('ENG-12').then(() => said('Copied'));
  document.getElementById('open').onclick = () => studio.open('https://linear.app/team/issue/ENG-12').then(() => said('Opened'));
  document.getElementById('ask').onclick = () =>
    studio.ask('Summarize ENG-12', { model: 'sonnet', json: true }).then((answer) => said(answer.summary), (error) => said(error.message));
  document.getElementById('send').onclick = () => studio.chat('Fix ENG-12', { send: true });
</script>`;
  await replySavingScreen(page, (conversationId) =>
    screen(conversationId, { html: tools, actions: [] }),
  );
  await page.evaluate(() => {
    const w = window as any;
    w.copiedText = [];
    navigator.clipboard.writeText = async (text: string) => {
      w.copiedText.push(text);
    };
    w.screenAnswer = '```json\n{"summary":"A sync fix"}\n```';
  });
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = frameOf(page);
  await frame.getByRole('button', { name: 'Copy' }).click();
  await expect(frame.locator('#said')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as any).copiedText)).toEqual(['ENG-12']);
  await frame.getByRole('button', { name: 'Open' }).click();
  await expect(frame.locator('#said')).toHaveText('Opened');
  expect(await page.evaluate(() => (window as any).openedLinks)).toEqual([
    'https://linear.app/team/issue/ENG-12',
  ]);
  await frame.getByRole('button', { name: 'Ask' }).click();
  await expect(frame.locator('#said')).toHaveText('A sync fix');
  expect(await page.evaluate(() => (window as any).screenAsks)).toEqual([
    { op: 'ask', id: screenId, prompt: 'Summarize ENG-12', model: 'sonnet' },
  ]);
  // A command of the page's own runs where it names, in bash in WSL.
  await page.evaluate(() => ((window as any).screenOutputs.command = '2 pull requests\n'));
  await frame.getByRole('button', { name: 'Exec' }).click();
  await expect(frame.locator('#said')).toHaveText('2 pull requests');
  expect((await starts(page)).at(-1)).toEqual({
    op: 'start',
    id: screenId,
    command: { shell: 'bash', script: 'gh pr list', where: 'wsl' },
    params: { limit: 5 },
    keep: false,
  });
  // A hidden page opens no chat.
  const inside = await pageFrame(page);
  await page.getByRole('button', { name: 'Open the chat that made this screen' }).click();
  await expect(page.getByRole('heading', { name: 'My pull requests' })).toBeHidden();
  expect(
    await inside.evaluate(() =>
      (window as any).studio.chat('Do something').then(
        () => 'opened',
        (error: Error) => error.message,
      ),
    ),
  ).toBe('studio.chat works while the screen is shown.');
  // A shown page sends the chat it asks for.
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await page.getByRole('button', { name: 'My pull requests', exact: true }).click();
  const runs = Number(await page.evaluate(() => localStorage.getItem('test-run-count')));
  await frame.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() => page.evaluate(() => Number(localStorage.getItem('test-run-count'))))
    .toBe(runs + 1);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-last-request')!).messages.at(-1).text,
    ),
  ).toBe('Fix ENG-12');
});

test('a screen answers only its own frame, however many calls wait', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const probe = `<p id="flood"></p><script>
    // Not a call of this frame's bridge: wrong names and tokens are ignored.
    parent.postMessage({ type: 'studio-screen', token: 'guess', id: 99, method: 'start', action: 'list_prs' }, '*');
    parent.postMessage({ type: 'studio-screen', token: 'guess', id: 98, method: 'start', command: { shell: 'powershell', script: 'Remove-Item x' } }, '*');
    // However many calls wait at once, each reaches the computer.
    for (let call = 0; call < 9; call++)
      studio.run('list_prs', { since: '2026-09-28' }).catch((error) => {
        document.getElementById('flood').textContent += error.message;
      });
  </script>`;
  await replySavingScreen(page, (conversationId) => screen(conversationId, { html: probe }));
  await page.evaluate(() => ((window as any).holdScreenRun = true));
  await page.getByRole('button', { name: 'My pull requests Open screen' }).click();
  const frame = frameOf(page);
  // Only the bridge's own calls reached the computer, every one of them.
  await expect.poll(async () => (await starts(page)).length).toBe(9);
  expect((await starts(page)).every((r: { action?: string }) => r.action === 'list_prs')).toBe(
    true,
  );
  await expect(frame.locator('#flood')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Jobs, 9 running' })).toBeVisible();
  await page.evaluate(() => (window as any).releaseScreenRun());
  await expect(page.getByRole('button', { name: 'Jobs', exact: true })).toBeVisible();
});
