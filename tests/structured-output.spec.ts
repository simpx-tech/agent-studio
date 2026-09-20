import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const schema = JSON.stringify({
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
});
for (const provider of ['Codex', 'Claude']) {
  test(`${provider} schema validation, output, history, disabling and narrow editor`, async ({
    page,
  }) => {
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await chooseTestFolder(page);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page
      .getByRole('option', { name: new RegExp(provider) })
      .first()
      .click();
    const input = page.getByLabel('Message', { exact: true });
    await input.fill('Keep my draft');
    await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
    const editor = page.getByLabel('Structured output · JSON Schema');
    await editor.fill('{');
    await expect(page.getByRole('alert')).toContainText('valid JSON');
    await expect(page.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
    await editor.fill('[]');
    await expect(page.getByRole('alert')).toContainText('describe an object');
    await editor.fill(schema);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Save instructions' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Save instructions' })).toBeInViewport();
    await page.screenshot({ path: `artifacts/structured-output/${provider}-editor-mobile.png` });
    await page.getByRole('button', { name: 'Save instructions' }).click();
    await expect(input).toHaveValue('Keep my draft');
    await expect(page.locator('.message')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const request = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('test-last-request')!),
    );
    expect(request.agent.outputSchema).toBe(schema);
    const result = JSON.stringify(
      { answer: '<script>window.bad=true</script>\n```html\n<h1>safe</h1>' },
      null,
      2,
    );
    await page.evaluate((text) => {
      (window as any).emitCapability({ kind: 'text', text });
      (window as any).finishCapabilities('complete');
    }, result);
    await expect(page.getByLabel('Structured output', { exact: true })).toHaveText(result);
    expect(await page.evaluate(() => (window as any).bad)).toBeUndefined();
    await page.screenshot({ path: `artifacts/structured-output/${provider}-result-mobile.png` });
    await page.setViewportSize({ width: 1380, height: 900 });
    await page.reload();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.locator('.conversation-item').first().click();
    await expect(page.getByLabel('Structured output', { exact: true })).toHaveText(result);
    await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
    await expect(editor).toHaveValue(schema);
    await editor.fill('');
    await page.getByRole('button', { name: 'Save instructions' }).click();
    await input.fill('Normal reply');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const next = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
    expect(next.agent.outputSchema).toBeUndefined();
    expect(next.messages.some((m: any) => m.role === 'assistant' && m.text === result)).toBe(true);
    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Normal **Markdown** reply' });
      (window as any).finishCapabilities('complete');
    });
    await expect(
      page.locator('.message').last().locator('strong').filter({ hasText: 'Markdown' }),
    ).toBeVisible();
    await expect(page.getByLabel('Structured output', { exact: true })).toHaveCount(1);
    await page.screenshot({ path: `artifacts/structured-output/${provider}-history-desktop.png` });
  });
}
