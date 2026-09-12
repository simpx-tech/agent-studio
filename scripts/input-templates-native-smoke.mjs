// Isolated native UI -> real workspace save/load -> draft insertion, with no chat submission.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const page = await nativePage(Number(process.env.TEMPLATE_QA_PORT ?? 9481));
const name = 'Template QA summary';
async function fill(label, value) {
  await page.evaluate(
    (label, value) => {
      const input =
        label === 'Message'
          ? document.querySelector('[aria-label="Message"]')
          : [...document.querySelectorAll('dialog label')]
              .find((el) => el.textContent.trim() === label)
              ?.querySelector('input, textarea');
      assertInput(input);
      function assertInput(input) {
        if (!input) throw new Error(`Missing input: ${label}`);
      }
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
}
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.input-templates-qa',
  );
  await page.waitFor(() => document.querySelector('.template-button')?.disabled === false);
  const before = await page.invoke('load_workspace');
  assert.equal(
    before.conversations.length,
    0,
    'Native QA workspace must contain no conversations.',
  );
  assert(
    (before.inputTemplates ?? []).every((template) => template.name.startsWith('Template QA ')),
    'Native QA library must be disposable.',
  );
  await fill('Message', 'Keep this draft.');
  await page.button('Templates');
  if (!(before.inputTemplates ?? []).some((template) => template.name === name)) {
    await page.button('New template');
    await page.waitFor(() => !!document.querySelector('dialog input[maxlength="80"]'));
    await fill('Template name', name);
    await fill('Template text', 'Summarize {{subject}} for {{audience}}.\nSubject: {{ subject }}');
    await page.button('Save template');
    await page.waitFor(
      () => document.querySelector('dialog h2')?.textContent === 'Input templates',
    );
  }
  await page.button(`Use ${name}`);
  await page.waitFor(() => document.querySelectorAll('dialog textarea').length === 2);
  await fill('subject', 'Reusable prompts\nwith custom inputs');
  await fill('audience', 'the team');
  const expected =
    'Keep this draft.\n\nSummarize Reusable prompts\nwith custom inputs for the team.\nSubject: Reusable prompts\nwith custom inputs';
  await page.waitFor(
    (expected) => document.querySelector('.template-preview pre')?.textContent === expected,
    expected,
  );
  await mkdir('artifacts', { recursive: true });
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/input-templates-native-preview.png', Buffer.from(shot.data, 'base64'));
  await page.button('Insert into message');
  await page.waitFor(
    (expected) =>
      document.querySelector('[aria-label="Message"]')?.value === expected &&
      !document.querySelector('dialog'),
    expected,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'Message',
  );
  assert.equal(await page.evaluate(() => document.querySelectorAll('.message').length), 0);
  const saved = await page.invoke('load_workspace');
  assert.equal(saved.conversations.length, 0, 'Insertion must never create a conversation or run.');
  assert.equal(
    saved.inputTemplates.find((template) => template.name === name).body,
    'Summarize {{subject}} for {{audience}}.\nSubject: {{ subject }}',
  );
  assert(
    !JSON.stringify(saved).includes('with custom inputs'),
    'Filled values must not be saved as defaults.',
  );
  await page.evaluate(() => {
    window.templateQaReload = true;
  });
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.templateQaReload && document.querySelector('.template-button')?.disabled === false,
  );
  await page.button('Templates');
  await page.button(`Use ${name}`);
  await page.waitFor(() => document.querySelectorAll('dialog textarea').length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('dialog textarea')].map((el) => el.value),
    ),
    ['', ''],
  );
  await page.button('Close input templates');
  assert.deepEqual(page.errors, []);
  await writeFile(
    'artifacts/input-templates-native-result.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        nativeSaveReload: true,
        draftPreserved: true,
        insertedWithoutSubmission: true,
        temporaryValuesCleared: true,
        runtimeErrors: page.errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'INPUT_TEMPLATES_NATIVE_PASSED: native save/reload, literal inputs, draft preservation, no submission, and cleared temporary values.',
  );
} finally {
  page.close();
}
