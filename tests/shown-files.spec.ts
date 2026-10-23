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
 * the computer is busy can come out without a frame, or with only its first few, so it is
 * recorded again until it plays and reaches 0.4 seconds in.
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
        video.onloadedmetadata = () => {
          if (!(video.videoWidth > 0)) return done(false);
          video.onseeked = () => done(video.currentTime > 0.35);
          video.currentTime = 0.4;
        };
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

/** A tone of `seconds` as 16-bit mono WAV, written in the page as the host would keep it. */
async function tone(page: Page, seconds: number) {
  return page.evaluate((seconds) => {
    const rate = 8000;
    const samples = rate * seconds;
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at: number, value: string) =>
      [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / 4) * 2000, true);
    const bytes = new Uint8Array(view.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mediaType: 'audio/wav', data: btoa(binary), bytes: bytes.length };
  }, seconds);
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

// Playwright's WebKit on Windows plays no audio, so playback runs in Edge alone.
test('a sound plays in its card, and the viewer shows the same player', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const [narration, chime] = [await tone(page, 12), await tone(page, 3)];
  await show(
    page,
    [
      { index: 0, name: 'narration.wav', mediaType: 'audio/wav', bytes: narration.bytes },
      { index: 1, name: 'chime.wav', mediaType: 'audio/wav', bytes: chime.bytes },
      // A kind a later release shows, which this one names without opening.
      { index: 0, name: 'plan.pdf', mediaType: 'application/pdf', bytes: 2048 },
    ],
    [narration, chime],
  );
  const answer = page.getByTestId('message').filter({ hasText: 'The report:' });
  // Its length comes from the file before it plays, and the slider waits for it.
  await expect(answer.getByText('WAV · 0:12 · 188 KB')).toBeVisible();
  const position = answer.getByRole('slider', { name: 'Position in narration.wav' });
  await expect(position).toHaveAttribute('aria-valuetext', '0:00 of 0:12');
  // The keys move along the sound, five seconds at a time.
  await position.focus();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveAttribute('aria-valuetext', '0:05 of 0:12');
  await page.keyboard.press('Home');
  await expect(position).toHaveAttribute('aria-valuetext', '0:00 of 0:12');
  // Space plays from the slider, and the place moves on as it plays.
  await page.keyboard.press(' ');
  const pause = answer.getByRole('button', { name: 'Pause narration.wav' });
  await expect(pause).toBeVisible();
  await expect(position).toHaveAttribute('aria-valuetext', /^0:0[1-9] of 0:12$/, {
    timeout: 5000,
  });

  // The viewer shows the same player, still playing, and closing it changes nothing.
  await answer.getByRole('button', { name: 'Expand narration.wav' }).click();
  const viewer = page.getByRole('dialog', { name: 'Audio preview' });
  await expect(viewer).toContainText('1 of 2');
  await expect(viewer.getByRole('button', { name: 'Pause narration.wav' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Mute narration.wav' }).click();
  await expect(viewer.getByRole('button', { name: 'Unmute narration.wav' })).toBeVisible();
  // The arrow keys move along the sound while its slider has focus, not to the next file.
  const inViewer = viewer.getByRole('slider', { name: 'Position in narration.wav' });
  await inViewer.focus();
  await page.keyboard.press('End');
  await expect(viewer).toContainText('1 of 2');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(answer.getByRole('button', { name: 'Unmute narration.wav' })).toBeVisible();
  // At the end of the sound its thumb stays within the bar, and the chat never scrolls sideways.
  await expect(position).toHaveAttribute('aria-valuetext', '0:12 of 0:12');
  const thumb = (await answer.locator('.audio-thumb').first().boundingBox())!;
  const bar = (await answer.locator('.audio-track').first().boundingBox())!;
  expect(thumb.x + thumb.width).toBeLessThanOrEqual(bar.x + bar.width + 1.5);
  expect(thumb.x + thumb.width).toBeGreaterThan(bar.x + bar.width - 3);
  expect(
    await page.evaluate(() => {
      const chat = document.querySelector('.chat-scroll')!;
      return chat.scrollWidth - chat.clientWidth;
    }),
  ).toBeLessThanOrEqual(0);

  // One sound plays at a time.
  await page.keyboard.press('Home');
  await answer.getByRole('button', { name: 'Play narration.wav' }).click();
  await expect(pause).toBeVisible();
  await answer.getByRole('button', { name: 'Play chime.wav' }).click();
  await expect(answer.getByRole('button', { name: 'Pause chime.wav' })).toBeVisible();
  await expect(answer.getByRole('button', { name: 'Play narration.wav' })).toBeVisible();
  await answer.getByRole('button', { name: 'Pause chime.wav' }).click();
  await expect(answer.getByRole('button', { name: 'Play chime.wav' })).toBeVisible();

  await expect(answer.getByText('Needs a newer Agent Studio')).toBeVisible();
  // Saved where releases before audio never read it, and never its bytes.
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace') ?? '');
  const message = JSON.parse(saved)
    .conversations.flatMap((c: any) => c.messages)
    .find((m: any) => m.role === 'assistant');
  expect(message.laterSentFiles.map((g: any) => g.id)).toEqual(['report']);
  expect(message.extraSentFiles ?? []).toEqual([]);
  expect(saved).not.toContain(chime.data.slice(0, 64));
});

test('a sound that cannot play says so, and its player fits a phone @webkit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const broken = { mediaType: 'audio/mpeg', data: btoa('not a sound at all'), bytes: 18 };
  await show(
    page,
    [
      {
        index: 0,
        name: 'a-rather-long-narration-name-for-a-phone.mp3',
        mediaType: 'audio/mpeg',
        bytes: 18,
      },
    ],
    [broken],
  );
  const answer = page.getByTestId('message').filter({ hasText: 'The report:' });
  const name = 'a-rather-long-narration-name-for-a-phone.mp3';
  await expect(answer.getByText('This file cannot be played here.')).toBeVisible();
  await expect(answer.getByRole('slider', { name: `Position in ${name}` })).toBeDisabled();
  // Nothing in the card reaches past the chat's width.
  const overflow = await answer.evaluate((element) => {
    const card = element.querySelector('.file-card')!;
    return card.scrollWidth - card.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  // Retry reads it again, and it fails again with the same line.
  await answer.getByRole('button', { name: 'Retry' }).click();
  await expect(answer.getByText('This file cannot be played here.')).toBeVisible();
  await expect(answer.getByRole('button', { name: `Play ${name}` })).toBeVisible();
  // The viewer shows the same player, inside the window.
  await answer.getByRole('button', { name: `Expand ${name}` }).click();
  const viewer = page.getByRole('dialog', { name: 'Audio preview' });
  const play = viewer.getByRole('button', { name: `Play ${name}` });
  await expect(play).toBeVisible();
  const box = (await viewer.locator('.audio-panel').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});
