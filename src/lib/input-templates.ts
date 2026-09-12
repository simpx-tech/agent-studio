import { z } from 'zod';

export const maxInputLength = 30000;
export const maxInputTemplates = 100;
export const maxTemplateFields = 20;
const placeholder = /\{\{([^{}]*)\}\}/g;

// Deliberately plain text: values are substituted once, never evaluated or parsed again.
export function templateFields(body: string): string[] {
  const fields: string[] = [];
  const remaining = body.replace(placeholder, (_, raw: string) => {
    const name = raw.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(name))
      throw new Error('Use field names of 1–60 letters, numbers, spaces, underscores or hyphens.');
    if (!fields.includes(name)) fields.push(name);
    return '';
  });
  if (remaining.includes('{{') || remaining.includes('}}'))
    throw new Error('Close each field with two braces, for example {{topic}}.');
  if (fields.length > maxTemplateFields)
    throw new Error(`Use at most ${maxTemplateFields} different fields in a template.`);
  return fields;
}

export const inputTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  body: z
    .string()
    .min(1)
    .max(maxInputLength)
    .superRefine((body, ctx) => {
      if (!body.trim()) ctx.addIssue({ code: 'custom', message: 'Enter template text.' });
      try {
        templateFields(body);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
});
export const inputTemplatesSchema = z
  .array(inputTemplateSchema)
  .max(maxInputTemplates)
  .refine(
    (templates) => new Set(templates.map((template) => template.id)).size === templates.length,
    'Template IDs must be unique.',
  );
export type InputTemplate = z.infer<typeof inputTemplateSchema>;

export function renderInputTemplate(body: string, values: Record<string, string>): string {
  templateFields(body);
  // Repeated placeholders can multiply a long value many times. Bound the final
  // size before constructing it, including fields that shrink to empty strings.
  let length = body.length;
  for (const match of body.matchAll(placeholder)) {
    const name = match[1].trim();
    length += (Object.hasOwn(values, name) ? values[name].length : 0) - match[0].length;
  }
  if (length > maxInputLength)
    throw new Error('The filled template exceeds 30,000 characters. Shorten the inputs.');
  return body.replace(placeholder, (_, raw: string) =>
    Object.hasOwn(values, raw.trim()) ? values[raw.trim()] : '',
  );
}

export function appendTemplateInput(draft: string, text: string): string {
  const result = draft + (draft && !draft.endsWith('\n\n') ? '\n\n' : '') + text;
  if (result.length > maxInputLength)
    throw new Error(
      'The combined message exceeds 30,000 characters. Shorten the template inputs or your draft.',
    );
  return result;
}
