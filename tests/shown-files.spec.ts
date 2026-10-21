import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

/**
 * Tables, documents and videos a reply shows (send_files): a card in the chat, and the whole
 * file in the file viewer, read from the computer that keeps it.
 */
const spreadsheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const salesRows = (count: number) => {
  const rows = [['Region', 'Quarter', 'Sales', 'Growth', 'Notes']];
  for (let i = 1; i < count; i++)
    rows.push([
      ['North', 'South', 'East', 'West'][i % 4],
      `Q${(i % 4) + 1} 2026`,
      (i * 137.5).toFixed(2),
      `${((i % 17) - 8) * 1.5}%`,
      i % 5 ? '' : 'Reviewed with the regional team before the close of the quarter',
    ]);
  return rows;
};
const report = [
  '# Quarterly report',
  '',
  'Sales grew **12%** over the quarter, led by the *North* region.',
  '',
  '- [Dashboard](https://example.com/dashboard)',
  '',
  ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the quarter's details.\n`),
].join('\n');

/**
 * A short video recorded in the page, as WebM where the engine records it. A recording made while
 * the computer is busy can come out without a frame, so it is recorded again until it plays.
 */
async function recordVideo(page: Page) {
  return page.evaluate(async () => {
    const record = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      const type = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.start();
      for (let frame = 0; frame < 20; frame++) {
        context.fillStyle = `hsl(${frame * 15} 60% 45%)`;
        context.fillRect(0, 0, 320, 180);
        await new Promise((resolve) => setTimeout(resolve, 33));
      }
      recorder.stop();
      await new Promise((resolve) => (recorder.onstop = resolve));
      return new Blob(chunks, { type });
    };
    const plays = (blob: Blob) =>
      new Promise<boolean>((resolve) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(blob);
        const done = (ok: boolean) => {
          URL.revokeObjectURL(url);
          resolve(ok);
        };
        video.onloadedmetadata = () => done(video.videoWidth > 0);
        video.onerror = () => done(false);
        setTimeout(() => done(false), 3000);
        video.src = url;
      });
    let blob = await record();
    for (let attempt = 0; attempt < 4 && !(await plays(blob)); attempt++) blob = await record();
    const data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
    return { mediaType: blob.type, data, bytes: blob.size };
  });
}

/** Answers a message with one group of files, kept by the mock host as `others`. */
async function show(page: Page, files: unknown[], others: unknown[]) {
  await page.evaluate((others) => {
    (window as any).toolOutputs = { toolu_report: { others } };
  }, others);
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Send the report');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => Object.keys((window as any).capabilityRuns ?? {}).length === 1);
  await page.evaluate((files) => {
    const w = window as any;
    const runId = Object.keys(w.capabilityRuns)[0];
    w.emitCapability({
      kind: 'text',
      text: 'The report:\n\n<!-- files:report -->\n\nThat is all.',
    });
    w.emitCapability({
      kind: 'sentfiles',
      sentFiles: { id: 'report', revision: 1, runId, toolId: 'toolu_report', caption: 'Q3', files },
    });
    w.finishCapabilities('complete');
  }, files);
}

test('a table and a document show their beginning in the reply and open whole, sheet by sheet @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await show(
    page,
    [
      { index: 0, name: 'sales.csv', mediaType: 'text/csv', bytes: 81_234 },
      { index: 1, name: 'report.md', mediaType: 'text/markdown', bytes: 4_100 },
      { index: 2, name: 'q3.xlsx', mediaType: spreadsheet, bytes: 9_000 },
    ],
    [
      { mediaType: 'text/csv', sheets: [{ name: 'sales', rows: salesRows(2501) }] },
      { mediaType: 'text/markdown', text: report },
      {
        mediaType: spreadsheet,
        sheets: [
          {
            name: 'Summary',
            rows: [
              ['Region', 'Total'],
              ['North', '1234.5'],
            ],
            firstRow: 2,
            firstColumn: 2,
          },
          { name: 'Notes', rows: [['Checked by hand']] },
        ],
      },
    ],
  );
  const answer = page.getByTestId('message').filter({ hasText: 'The report:' });
  // The table's first rows, numbered as its file numbers them, its first row the header.
  const preview = answer.getByRole('table', { name: 'sales' });
  await expect(preview.getByRole('columnheader', { name: 'Region' })).toBeVisible();
  await expect(preview.getByRole('row').nth(1)).toContainText('South');
  await expect(preview.getByRole('row')).toHaveCount(9);
  await expect(answer.getByText('CSV · 2,501 rows × 5 columns · 79 KB')).toBeVisible();
  await expect(answer.getByText('XLSX · 2 sheets · 8.8 KB')).toBeVisible();
  // The document's beginning, rendered, read with no more than its card shows.
  await expect(answer.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  const calls = () => page.evaluate(() => (window as any).toolOutputCalls as any[]);
  expect((await calls()).filter((call) => call.command === 'read_tool_output_document')).toEqual([
    expect.objectContaining({ index: 1, head: 16_384 }),
  ]);

  // A click on the rows opens the whole table, whose rows come a page at a time as it scrolls.
  await preview.getByRole('cell', { name: 'South' }).first().click();
  const table = page.getByRole('dialog', { name: 'Table preview' });
  await expect(table).toContainText('1 of 3');
  const grid = table.getByRole('table', { name: 'sales' });
  await expect(grid.getByRole('rowheader', { name: '28', exact: true })).toBeVisible();
  // The arrow keys scroll a focused table rather than step to another file.
  await grid.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(table).toContainText('1 of 3');
  // At once, ending the arrows' own glide.
  await grid.evaluate((element) => element.scrollTo({ top: 40_000, behavior: 'instant' }));
  await expect(grid.getByRole('rowheader', { name: '1440', exact: true })).toBeVisible();
  // The header stays above the rows it names.
  const header = (await grid.getByRole('columnheader', { name: 'Region' }).boundingBox())!;
  expect(header.y).toBeLessThan(
    (await grid.getByRole('rowheader', { name: '1440' }).boundingBox())!.y,
  );
  const pages = (await calls()).filter((call) => call.command === 'read_tool_output_table');
  expect(pages.some((call) => call.index === 0 && call.start === 1400)).toBe(true);

  // The next file is the whole document.
  await table.getByRole('button', { name: 'Next file' }).click();
  const document = page.getByRole('dialog', { name: 'Document preview' });
  await expect(document).toContainText('2 of 3');
  await expect(document.getByText('Paragraph 60', { exact: false })).toBeVisible();
  // Its links open in the browser, never in the window.
  await document.getByRole('link', { name: 'Dashboard' }).click();
  await expect(document).toBeVisible();

  // And then the workbook, a sheet at a time, numbered from its first cell.
  await document.getByRole('button', { name: 'Next file' }).click();
  const workbook = page.getByRole('dialog', { name: 'Table preview' });
  await expect(workbook).toContainText('3 of 3');
  await expect(workbook.getByRole('rowheader', { name: '2', exact: true })).toBeVisible();
  await workbook.getByRole('tab', { name: 'Notes' }).click();
  await expect(workbook.getByRole('tab', { name: 'Notes' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(workbook.getByText('Checked by hand')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(workbook).toBeHidden();

  // The reply keeps these groups apart, where releases that cannot show them never read them,
  // and never their contents.
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace') ?? '');
  const message = JSON.parse(saved)
    .conversations.flatMap((c: any) => c.messages)
    .find((m: any) => m.role === 'assistant');
  expect(message.sentFiles ?? []).toEqual([]);
  expect(message.extraSentFiles.map((g: any) => g.id)).toEqual(['report']);
  expect(saved).not.toContain('Paragraph 60');
  expect(saved).not.toContain('Reviewed with the regional team');
});

test('a video plays in the reply, and the viewer takes it up where it stood', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const video = await recordVideo(page);
  await show(
    page,
    [{ index: 0, name: 'demo.webm', mediaType: video.mediaType, bytes: video.bytes }],
    [video],
  );
  const answer = page.getByTestId('message').filter({ hasText: 'The report:' });
  const inline = answer.getByLabel('demo.webm', { exact: true });
  await expect(inline).toBeVisible();
  await expect
    .poll(() => inline.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThan(0);
  // Its size comes from the file once the player reads it.
  await expect(answer.getByText(/320 × 180/)).toBeVisible();
  // Moved along in the chat, the viewer starts there, and pauses the chat's player meanwhile.
  await inline.evaluate((element: HTMLVideoElement) => (element.currentTime = 0.3));
  await answer.getByRole('button', { name: 'Expand demo.webm' }).click();
  const viewer = page.getByRole('dialog', { name: 'Video preview' });
  const expanded = viewer.getByLabel('demo.webm', { exact: true });
  await expect(expanded).toBeVisible();
  await expect
    .poll(() => expanded.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(0.3, 1);
  // The picture takes the room the window leaves it, its shape kept.
  const box = (await expanded.boundingBox())!;
  expect(box.width).toBeGreaterThan(700);
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  // A click on the scrim beside it closes the viewer.
  await page.mouse.click(box.x / 2, box.y + box.height / 2);
  await expect(viewer).toBeHidden();
});
