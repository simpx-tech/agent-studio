import { z } from 'zod';

const clean = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s));
export const maxMentions = 16;
export const mentionSchema = z
  .object({
    kind: z.enum(['file', 'app']),
    name: clean(4096),
    path: clean(4096),
    token: clean(4100),
  })
  .strict()
  .refine((m) =>
    m.kind === 'app'
      ? /^app:\/\/[\w.-]+$/.test(m.path) && /^\$[\w-]+$/.test(m.token)
      : !m.name.includes('"') &&
        /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(m.path) &&
        m.token === fileToken(m.name),
  );
export type Mention = z.infer<typeof mentionSchema>;
export const mentionResultSchema = z.object({
  entries: z.array(mentionSchema).max(200),
  truncated: z.boolean(),
  notice: z.string().max(1000),
});
export type MentionResult = z.infer<typeof mentionResultSchema>;
export const mentionRequestSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    connectionId: z.string().uuid(),
    conversationId: z.string().uuid().nullable(),
    location: z
      .object({
        computerId: z.string().uuid(),
        environmentId: z.string().uuid(),
        executionEnvironmentId: z.string().uuid().optional(),
        path: clean(4096),
      })
      .strict()
      .nullable(),
    kind: z.enum(['file', 'app']),
    query: z
      .string()
      .max(256)
      .refine((s) => !/[\x00-\x1f\x7f]/.test(s)),
  })
  .strict()
  .refine((r) => r.kind !== 'app' || r.provider === 'codex');

export function fileToken(path: string) {
  return /[\s"()\[\]`]/.test(path) ? `@"${path}"` : `@${path}`;
}
export type MentionQuery = { kind: 'file' | 'app'; query: string; start: number; end: number };
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  const before = text.slice(0, caret);
  // Do not suggest inside inline/fenced code or email addresses.
  if ((before.match(/`/g)?.length ?? 0) % 2) return;
  const match = /(?:^|[\s(\[])([@$])("[^"\n]*|[^\s"`()[\]]*)$/.exec(before);
  if (!match) return;
  const raw = match[2];
  if (match[1] === '$' && raw && !/^[A-Za-z_][\w-]*$/.test(raw)) return;
  const query = raw.startsWith('"') ? raw.slice(1) : raw;
  if (query.length > 256) return;
  const start = caret - raw.length - 1;
  const after = text.slice(caret);
  const tail = raw.startsWith('"')
    ? /^[^"\n]*(?:"|$)/.exec(after)?.[0]
    : /^[^\s"`()[\]]*/.exec(after)?.[0];
  return {
    kind: match[1] === '@' ? 'file' : 'app',
    query,
    start,
    end: caret + (tail?.length ?? 0),
  };
}
export function hasMention(text: string, token: string) {
  let index = text.indexOf(token);
  while (index >= 0) {
    const end = index + token.length;
    if (
      (!index || /[\s(\[]/.test(text[index - 1])) &&
      (end === text.length ||
        (token.startsWith('$') ? /[\s)\],.;!?]/ : /[\s)\],;!?]/).test(text[end]))
    )
      return true;
    index = text.indexOf(token, index + 1);
  }
  return false;
}
export function retainMentions(text: string, mentions: Mention[]) {
  const seen = new Set<string>();
  return mentions
    .filter((m) => hasMention(text, m.token) && !seen.has(m.token) && !!seen.add(m.token))
    .map((m) => ({ ...m }));
}
