import { z } from 'zod';

const placeholder = /\{\{([^{}]*)\}\}/g;

// Deliberately plain text: values are substituted once, never evaluated or parsed again.
export function templateFields(body: string): string[] {
  const fields: string[] = [];
  const remaining = body.replace(placeholder, (_, raw: string) => {
    const name = raw.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name))
      throw new Error('Use field names of letters, numbers, spaces, underscores or hyphens.');
    if (!fields.includes(name)) fields.push(name);
    return '';
  });
  if (remaining.includes('{{') || remaining.includes('}}'))
    throw new Error('Close each field with two braces, for example {{topic}}.');
  return fields;
}

export const inputTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  body: z
    .string()
    .min(1)
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
  .refine(
    (templates) => new Set(templates.map((template) => template.id)).size === templates.length,
    'Template IDs must be unique.',
  );
export type InputTemplate = z.infer<typeof inputTemplateSchema>;

export function renderInputTemplate(body: string, values: Record<string, string>): string {
  templateFields(body);
  return body.replace(placeholder, (_, raw: string) =>
    Object.hasOwn(values, raw.trim()) ? values[raw.trim()] : '',
  );
}

export function appendTemplateInput(draft: string, text: string): string {
  return draft + (draft && !draft.endsWith('\n\n') ? '\n\n' : '') + text;
}
