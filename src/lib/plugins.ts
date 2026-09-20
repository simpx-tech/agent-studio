import { z } from 'zod';
import { mcpRequestSchema } from './mcp.ts';

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.trim() === s && !/[\x00-\x1f\x7f]/.test(s));
const id = text.refine((s) => s.length <= 200 && !s.startsWith('-'));
const path = text.refine(
  (s) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s),
  'Use an absolute path on the selected computer.',
);
const url = text.url().refine((s) => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'Use a public HTTPS zip URL without credentials or query parameters.');
export const pluginActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z.object({ kind: z.literal('details'), id }).strict(),
  z.object({ kind: z.literal('install'), id }).strict(),
  z.object({ kind: z.literal('toggle'), id, enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('uninstall'), id }).strict(),
  z.object({ kind: z.literal('skill'), path, enabled: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('runtime'),
      pluginDirs: z.array(path).max(8),
      pluginUrls: z.array(url).max(8),
      skillRoots: z.array(path).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal('eval'),
      id,
      operationId: z.string().uuid(),
      maxCostUsd: z.number().finite().min(0.01).max(100),
      trusted: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal('cancel'), operationId: z.string().uuid() }).strict(),
]);
export const pluginRequestSchema = mcpRequestSchema
  .omit({ action: true })
  .extend({ action: pluginActionSchema })
  .strict();
export type PluginAction = z.infer<typeof pluginActionSchema>;
export type PluginView = {
  id: string;
  name: string;
  version: string;
  scope: string;
  enabled: boolean | null;
};
export type PluginResult = {
  plugins: PluginView[];
  message: string;
  details: string[];
  pluginDirs: string[];
  pluginUrls: string[];
  skillRoots: string[];
};
