import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      s.trim() === s && !s.startsWith('-') && !/[\x00-\x1f\x7f]/.test(s) && s !== 'agent_studio',
  );
const endpoint = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Use HTTPS (or local HTTP), without embedded credentials.');
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\x00-\x1f]/.test(s));
export const mcpServerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), url: endpoint }).strict(),
  z.object({ type: z.literal('sse'), url: endpoint }).strict(),
  z.object({ type: z.literal('stdio'), command: text, args: z.array(text).max(64) }).strict(),
]);
export type McpServer = z.infer<typeof mcpServerSchema>;
export const mcpActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status') }).strict(),
  z.object({ kind: z.literal('login'), name }).strict(),
  z.object({ kind: z.literal('authenticate'), name }).strict(),
  z.object({ kind: z.literal('reconnect'), name }).strict(),
  z.object({ kind: z.literal('toggle'), name, enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('add'), name, server: mcpServerSchema }).strict(),
  z.object({ kind: z.literal('logout'), name }).strict(),
  z.object({ kind: z.literal('reload') }).strict(),
  z
    .object({
      kind: z.literal('setServers'),
      servers: z
        .record(name, mcpServerSchema)
        .refine(
          (s) =>
            Object.keys(s).length <= 20 &&
            !('agent_studio' in s) &&
            JSON.stringify(s).length <= 64_000,
        ),
    })
    .strict(),
  z.object({ kind: z.literal('poll'), operationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('cancel'), operationId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('callback'),
      operationId: z.string().uuid(),
      callbackUrl: z.string().max(8192).url(),
    })
    .strict(),
]);
export type McpAction = z.infer<typeof mcpActionSchema>;
export type McpResult = {
  status: 'complete' | 'pending' | 'failed' | 'cancelled';
  message: string;
  operationId?: string;
  authorizationUrl?: string;
  callbackAllowed?: boolean;
  servers: { name: string; status: string }[];
};
export const mcpRequestSchema = z
  .object({
    provider: z.enum(['claude', 'codex']),
    connectionId: z.string().uuid(),
    conversationId: z.string().uuid().nullable().optional(),
    location: z
      .object({
        computerId: z.string().uuid(),
        environmentId: z.string().uuid(),
        executionEnvironmentId: z.string().uuid().optional(),
        path: z.string().max(4096),
      })
      .strict()
      .nullable()
      .optional(),
    action: mcpActionSchema,
  })
  .strict();
