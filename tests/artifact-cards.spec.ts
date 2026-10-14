import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// An artifact a reply writes shows as a card that opens it, in place of its code: in the answer,
// in the reply's own comments, and while the reply still writes it (src/lib/artifacts.ts).
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const comment = (id: string, revision: number, text: string) => ({
  kind: 'progress',
  id,
  revision,
  text,
});
const finish = (page: Page, status: string) =>
  page.evaluate((status) => (window as any).finishCapabilities(status), status);

async function ask(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
}

/** The reply's blocks in the order they read: paragraphs, cards and code. */
const reading = (scope: Locator) =>
  scope.evaluate((element) =>
    [...element.querySelectorAll(':scope > p, :scope > .artifact-card, :scope > .code-block')].map(
      (child) =>
        child.classList.contains('artifact-card')
          ? `card: ${child.querySelector('.artifact-open')?.textContent}`
          : child.classList.contains('code-block')
            ? 'code'
            : child.textContent,
    ),
  );

const source = '<!doctype html>\n<title>Q3</title>\n<h1>Third quarter</h1>';
const written = `Here is the report.\n\n\`\`\`html Quarterly report\n${source}\n\`\`\`\n\nOpen it beside the chat.`;

test('an artifact shows as a card in place of its code, also while the reply writes it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Write the quarterly report');
  const reply = page.locator('.message').last();
  // Claude streams the turn's text as a comment of the reply's work until the turn ends.
  await emit(page, comment('turn', 1, written.slice(0, written.indexOf('<h1>') + 4)));
  const writing = reply.locator('.artifact-writing');
  await expect(writing).toHaveText(/Quarterly report\s*Writing · 3 lines/);
  await expect(reply.locator('.code-block')).toHaveCount(0);
  await expect(reply.getByRole('button', { name: /Quarterly report/ })).toHaveCount(0);
  await emit(page, comment('turn', 2, written));
  await emit(page, { kind: 'text', text: written });
  await finish(page, 'complete');
  const answer = reply.locator(':scope > .message-content > .prose');
  await expect(answer).toHaveCount(1);
  expect(await reading(answer)).toEqual([
    'Here is the report.',
    'card: Quarterly reportOpen HTML',
    'Open it beside the chat.',
  ]);
  await expect(reply.locator('.artifact-writing, .code-block, .response-artifacts')).toHaveCount(0);
  const open = reply.getByRole('button', { name: 'Quarterly report Open HTML', exact: true });
  // From the keyboard, so the card holds focus to take back in every engine.
  await open.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', { name: 'Quarterly report', exact: true });
  await expect(
    page.frameLocator('iframe[title="Quarterly report preview"]').getByRole('heading'),
  ).toHaveText('Third quarter');
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe(source);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
  await reply
    .getByRole('button', { name: 'Open Quarterly report in side panel', exact: true })
    .click();
  await expect(viewer).toHaveClass(/docked/);
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await page.screenshot({ path: 'artifacts/artifact-card.png' });
  // Saved history shows it the same way.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Write the quarterly report/ }).click();
  await expect(
    page.getByRole('button', { name: 'Quarterly report Open HTML', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message').last().locator('.code-block')).toHaveCount(0);
  // A phone keeps the card within the conversation.
  await page.setViewportSize({ width: 390, height: 844 });
  const card = (await page
    .locator('.message')
    .last()
    .locator('.prose .artifact-card')
    .boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/artifact-card-mobile.png' });
});

test('html a reply explains stays code, and reasoning and a stopped reply show no artifact cards', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'How do I center a div?');
  let reply = page.locator('.message').last();
  // Thinking never makes an artifact, whatever it writes.
  await emit(page, {
    kind: 'reasoning',
    id: 'r1',
    revision: 1,
    text: 'Draft:\n\n```html Draft page\n<!doctype html><title>Draft</title>\n```',
    truncated: false,
  });
  await expect(reply.locator('.reasoning-entry .code-block')).toHaveCount(1);
  const snippet =
    'Use flexbox:\n\n```html\n<div class="center">Hi</div>\n```\n\n```svg\n<svg/>\n```';
  await emit(page, { kind: 'text', text: snippet });
  await finish(page, 'complete');
  const answer = reply.locator(':scope > .message-content > .prose');
  await expect(answer.locator('.code-block')).toHaveCount(2);
  await expect(reply.locator('.artifact-card:not(.response-artifacts *)')).toHaveCount(0);
  // Code the reply explains still opens as an artifact from below it, as before.
  await expect(
    reply.locator('.response-artifacts').getByRole('button', { name: 'HTML artifact 1 Open HTML' }),
  ).toBeVisible();
  await reply.getByLabel('Work history', { exact: true }).click();
  await expect(reply.locator('.reasoning-entry .artifact-card')).toHaveCount(0);

  // A reply stopped while it wrote an artifact keeps what it wrote, as code.
  await ask(page, 'Write the onboarding page');
  reply = page.locator('.message').last();
  const unfinished = 'Here it is.\n\n```html Onboarding\n<!doctype html>\n<h1>Welcome</h1>';
  await emit(page, comment('turn', 1, unfinished));
  await expect(reply.locator('.artifact-writing')).toHaveText(/Onboarding\s*Writing · 2 lines/);
  await finish(page, 'cancelled');
  await expect(reply).toHaveAttribute('data-status', 'cancelled');
  await expect(reply.locator('.artifact-writing')).toHaveCount(0);
  await expect(reply.locator(':scope > .message-content > .prose .code-block')).toContainText(
    'Welcome',
  );
});

test('an artifact of an earlier turn stays in its comment and follows the answer', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Build the dashboard and check it');
  const reply = page.locator('.message').last();
  await emit(page, comment('first', 1, 'The dashboard:\n\n```html Dashboard\n<h1>KPIs</h1>\n```'));
  await emit(page, {
    kind: 'tool',
    tool: {
      id: 'check',
      operation: 'command',
      name: 'Bash',
      category: 'tool',
      revision: 1,
      status: 'complete',
      command: 'npm test',
      commandRun: true,
      facts: [],
      sources: [],
      agents: [],
    },
  });
  await emit(page, comment('last', 1, 'All checks passed.'));
  await emit(page, { kind: 'text', text: 'All checks passed.' });
  await finish(page, 'complete');
  // The answer is a short status, so the artifact its work wrote follows it.
  const below = reply.locator('.response-artifacts');
  await expect(below.getByRole('button', { name: 'Dashboard Open HTML' })).toBeVisible();
  await reply.getByLabel('Work history', { exact: true }).click();
  const history = reply.locator('.activity-timeline');
  await expect(history.locator('.code-block')).toHaveCount(0);
  await history.getByRole('button', { name: 'Dashboard Open HTML', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Dashboard', exact: true });
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe('<h1>KPIs</h1>');
});

// A page the agent wrote to a file and showed with its show_artifact tool: the reply keeps its
// source, places its card at the marker, and an open viewer follows each revision it shows.
test('a page shown with show_artifact sits at its marker and the viewer follows its revisions', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Make the quarterly page');
  const reply = page.locator('.message').last();
  const shown = (revision: number, heading: string) => ({
    kind: 'artifact',
    artifact: {
      id: 'report',
      revision,
      title: 'Quarterly report',
      language: 'html',
      source: `<!doctype html><title>Q3</title><h1>${heading}</h1>`,
    },
  });
  await emit(page, shown(1, 'First draft'));
  const card = reply.getByRole('button', { name: 'Quarterly report Open HTML', exact: true });
  await expect(card).toBeVisible();
  await reply
    .getByRole('button', { name: 'Open Quarterly report in side panel', exact: true })
    .click();
  const viewer = page.getByRole('dialog', { name: 'Quarterly report', exact: true });
  await expect(viewer).toHaveClass(/docked/);
  const frame = page.frameLocator('iframe[title="Quarterly report preview"]');
  await expect(frame.getByRole('heading')).toHaveText('First draft');
  // A page renders where it may load pinned CDN libraries.
  expect(await viewer.locator('iframe').getAttribute('src')).toBe('/artifact-page');
  // The agent fixed the page and showed it again under its id.
  await emit(page, shown(2, 'Final'));
  await expect(frame.getByRole('heading')).toHaveText('Final');
  await expect(card).toHaveCount(1);
  await emit(page, {
    kind: 'text',
    text: 'Here it is.\n\n<!-- artifact:report -->\n\nIt covers the third quarter.',
  });
  await finish(page, 'complete');
  const order = () =>
    page
      .locator('.message')
      .last()
      .locator(':scope > .message-content')
      .evaluate((content) =>
        [...content.children]
          .filter((child) => child.matches('.prose, .artifact-card'))
          .map((child) => (child.matches('.artifact-card') ? 'card' : child.textContent?.trim())),
      );
  expect(await order()).toEqual(['Here it is.', 'card', 'It covers the third quarter.']);
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  // Saved history keeps the page's latest source.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Make the quarterly page/ }).click();
  expect(await order()).toEqual(['Here it is.', 'card', 'It covers the third quarter.']);
  await page.getByRole('button', { name: 'Quarterly report Open HTML', exact: true }).click();
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe(
    '<!doctype html><title>Q3</title><h1>Final</h1>',
  );
});
