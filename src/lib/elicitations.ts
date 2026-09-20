import { z } from 'zod';

// Only this allowlist is portable. Request messages, schemas, URLs and answers
// must never enter workspace storage, exports, checkpoints or prompt history.
export const elicitationReceiptSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  revision: z.number().int().min(1).max(100),
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled']),
  mode: z.enum(['form', 'url']),
  serverName: z.string().min(1).max(200),
});
export type ElicitationReceipt = z.infer<typeof elicitationReceiptSchema>;
export const elicitationReceiptsSchema = z
  .array(elicitationReceiptSchema)
  .max(16)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length);
const valueSchema = z.union([
  z.string().max(4000),
  z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.array(z.string().max(200)).max(32),
]);
const count = z.number().int().nonnegative().max(4000).nullable();
const fieldSchema = z.object({
  key: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  description: z.string().max(1000),
  kind: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  required: z.boolean(),
  options: z
    .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(200) }))
    .max(32),
  minLength: count,
  maxLength: count,
  minimum: z.number().finite().nullable(),
  maximum: z.number().finite().nullable(),
  minItems: count,
  maxItems: count,
  format: z.enum(['email', 'uri', 'date', 'date-time']).nullable(),
  pattern: z.string().max(500).nullable(),
  default: valueSchema.nullable(),
});
export type ElicitationField = z.infer<typeof fieldSchema>;
export function safeElicitationUrl(raw: string) {
  try {
    const url = new URL(raw);
    return (
      raw.length <= 8000 &&
      !url.username &&
      !url.password &&
      !!url.hostname &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const elicitationRequestSchema = elicitationReceiptSchema
  .extend({
    message: z.string().min(1).max(4000),
    fields: z.array(fieldSchema).max(16),
    url: z.string().max(8000).refine(safeElicitationUrl).nullable(),
  })
  .refine(
    (r) =>
      r.status === 'pending' && (r.mode === 'url' ? !!r.url && !r.fields.length : r.url === null),
  );
export type ElicitationRequest = z.infer<typeof elicitationRequestSchema>;
export const elicitationInputSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(['accept', 'decline', 'cancel']).optional(),
    content: z.record(z.string().min(1).max(100), valueSchema).optional(),
  })
  .strict()
  .refine((v) => (!v.content || v.action === 'accept') && JSON.stringify(v).length <= 24000);
export type ElicitationInput = z.infer<typeof elicitationInputSchema>;
export function mergeElicitations(
  left: ElicitationReceipt[] = [],
  right: ElicitationReceipt[] = [],
) {
  const result = [...left];
  for (const item of right) {
    const parsed = elicitationReceiptSchema.safeParse(item);
    if (!parsed.success) continue;
    const index = result.findIndex((r) => r.id === item.id);
    if (index < 0 && result.length < 16) result.push(parsed.data);
    else if (
      index >= 0 &&
      result[index].runId === item.runId &&
      result[index].revision < item.revision &&
      result[index].status === 'pending'
    )
      result[index] = parsed.data;
  }
  return result;
}
export function formContent(fields: ElicitationField[], values: Map<string, unknown>) {
  const entries: [string, z.infer<typeof valueSchema>][] = [];
  for (const f of fields) {
    const raw = values.get(f.key);
    if (raw == null || (raw === '' && f.kind !== 'string')) {
      if (f.required) throw new Error(`Enter ${f.title}.`);
      continue;
    }
    const v = f.kind === 'number' || f.kind === 'integer' ? Number(raw) : raw;
    if (
      !valueSchema.safeParse(v).success ||
      (f.kind === 'boolean' && typeof v !== 'boolean') ||
      ((f.kind === 'number' || f.kind === 'integer') &&
        (typeof v !== 'number' ||
          !Number.isFinite(v) ||
          (f.kind === 'integer' && !Number.isInteger(v)) ||
          (f.minimum != null && v < f.minimum) ||
          (f.maximum != null && v > f.maximum))) ||
      (f.kind === 'string' &&
        (typeof v !== 'string' ||
          (f.minLength != null && Array.from(v).length < f.minLength) ||
          (f.maxLength != null && Array.from(v).length > f.maxLength) ||
          (f.options.length && !f.options.some((o) => o.value === v)))) ||
      (f.kind === 'array' &&
        (!Array.isArray(v) ||
          (f.minItems != null && v.length < f.minItems) ||
          (f.maxItems != null && v.length > f.maxItems) ||
          v.some((s) => !f.options.some((o) => o.value === s))))
    )
      throw new Error(`Check ${f.title} and its input limits.`);
    entries.push([f.key, v as z.infer<typeof valueSchema>]);
  }
  return Object.fromEntries(entries);
}
