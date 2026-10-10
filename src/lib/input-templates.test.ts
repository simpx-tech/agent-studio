import { describe, expect, it } from 'vitest';
import {
  appendTemplateInput,
  inputTemplateSchema,
  inputTemplatesSchema,
  renderInputTemplate,
  templateFields,
} from './input-templates';
import { initialWorkspace, restoreWorkspace } from './domain';
import { emptyShared, mergeShared, sharedSchema, sharedWorkspace } from './sync';

const template = () => ({
  id: crypto.randomUUID(),
  name: 'Review',
  body: 'Review {{topic}} for {{audience}}. Revisit {{ topic }}.',
});

describe('input templates', () => {
  it('deduplicates named fields in order and substitutes values literally, only once', () => {
    expect(templateFields(template().body)).toEqual(['topic', 'audience']);
    const values = { topic: '{{audience}} $& <script>alert(1)</script>\n第二行', audience: 'team' };
    expect(renderInputTemplate(template().body, values)).toBe(
      `Review ${values.topic} for team. Revisit ${values.topic}.`,
    );
    expect(templateFields('Plain reusable prompt')).toEqual([]);
    expect(templateFields('{{Título}} {{areas to check}}')).toEqual(['Título', 'areas to check']);
    expect(renderInputTemplate('{{constructor}} {{toString}}', {})).toBe(' ');
  });
  it('rejects malformed fields and repeated IDs, and keeps templates of any size or number', () => {
    for (const body of ['{{unfinished', '{{}}', '{{path.to.value}}', '   '])
      expect(inputTemplateSchema.safeParse({ ...template(), body }).success).toBe(false);
    // Field names, text and fields of any length or number.
    for (const body of [
      '{{' + 'a'.repeat(61) + '}}',
      'x'.repeat(30001),
      Array.from({ length: 21 }, (_, i) => `{{input ${i}}}`).join(' '),
    ])
      expect(inputTemplateSchema.safeParse({ ...template(), body }).success).toBe(true);
    expect(inputTemplateSchema.safeParse({ ...template(), name: 'n'.repeat(81) }).success).toBe(
      true,
    );
    const item = template();
    expect(inputTemplatesSchema.safeParse([item, item]).success).toBe(false);
    expect(inputTemplatesSchema.safeParse(Array.from({ length: 101 }, template)).success).toBe(
      true,
    );
  });
  it('preserves draft bytes and combines text of any length without truncation', () => {
    expect(appendTemplateInput('Existing draft  ', 'Filled template')).toBe(
      'Existing draft  \n\nFilled template',
    );
    expect(appendTemplateInput('Draft\n\n', 'Text')).toBe('Draft\n\nText');
    expect(appendTemplateInput('', 'x'.repeat(30000))).toHaveLength(30000);
    expect(appendTemplateInput('draft', 'x'.repeat(100_000))).toBe(
      `draft\n\n${'x'.repeat(100_000)}`,
    );
    expect(renderInputTemplate('{{a}}'.repeat(100), { a: 'x'.repeat(30000) })).toHaveLength(
      3_000_000,
    );
    expect(renderInputTemplate('{{a}}{{missing}}', { a: 'x'.repeat(30000) })).toHaveLength(30000);
  });
  it('round-trips definitions through old/new workspace storage, exports and relay schemas', () => {
    const old = initialWorkspace();
    expect(restoreWorkspace(JSON.parse(JSON.stringify(old))).inputTemplates).toBeUndefined();
    old.inputTemplates = [template()];
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(old)));
    expect(restored.inputTemplates).toEqual(old.inputTemplates);
    expect(sharedSchema.parse(sharedWorkspace(restored)).inputTemplates).toEqual(
      old.inputTemplates,
    );
  });
  it('merges independent edits and deletions, retaining conflicting template text', () => {
    const base = { ...emptyShared(), inputTemplates: [template(), template()] };
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.inputTemplates[0].body = 'Local {{value}}';
    remote.inputTemplates[1].name = 'Remote name';
    expect(mergeShared(base, local, remote).inputTemplates).toEqual([
      local.inputTemplates[0],
      remote.inputTemplates[1],
    ]);
    remote.inputTemplates[0].body = 'Remote {{other}}';
    const merged = mergeShared(base, local, remote);
    expect(merged.inputTemplates?.map((t) => t.body)).toEqual([
      'Remote {{other}}',
      'Local {{value}}',
      base.inputTemplates[1].body,
    ]);
    expect(merged.inputTemplates?.[1].name).toContain('(conflict copy)');
    expect(sharedSchema.safeParse(merged).success).toBe(true);
    remote.inputTemplates = [];
    const deleted = mergeShared(base, base, remote);
    expect(deleted.inputTemplates).toEqual([]);
    expect(mergeShared(base, local, remote).inputTemplates?.[0].body).toBe('Local {{value}}');
  });
});
