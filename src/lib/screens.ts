import { z } from 'zod';

/**
 * Screens (docs/SCREENS.md): lasting pages a chat saves in Agent Studio, kept on the computer
 * that runs their actions (src-tauri/src/screens.rs). Nothing here reaches the workspace: windows
 * read a screen and run its actions through transport, and a reply keeps only the card of each
 * screen it saved.
 */

export const screenIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const nameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const json = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return undefined;
  }
};

/**
 * What a window or another device asks the computer that keeps a screen. The relay checks it
 * strictly before routing, and the host checks it again against the screen it keeps.
 */
export const screenRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }).strict(),
  z.object({ op: z.literal('read'), id: screenIdSchema }).strict(),
  z
    .object({
      op: z.literal('run'),
      id: screenIdSchema,
      action: nameSchema,
      params: z.record(nameSchema, z.unknown()).optional(),
    })
    .strict()
    .refine((request) => json(request.params ?? {}) !== undefined),
  z
    .object({
      op: z.literal('approve'),
      id: screenIdSchema,
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ op: z.literal('revoke'), id: screenIdSchema }).strict(),
  z.object({ op: z.literal('delete'), id: screenIdSchema }).strict(),
  z.object({ op: z.literal('load'), id: screenIdSchema }).strict(),
  z
    .object({
      op: z.literal('save'),
      id: screenIdSchema,
      key: z
        .string()
        .min(1)
        .refine((key) => !/[\u0000-\u001f\u007f]/.test(key)),
      value: z.unknown(),
    })
    .strict()
    .refine((request) => json(request.value) !== undefined),
]);
export type ScreenRequest = z.infer<typeof screenRequestSchema>;
export const screenSummarySchema = z.object({
  id: screenIdSchema,
  revision: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  environmentId: z.string().uuid(),
  project: z.string(),
  folder: z.string(),
  conversationId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  commands: z.number().int().nonnegative(),
  allowed: z.boolean(),
});
export type ScreenSummary = z.infer<typeof screenSummarySchema>;

export const screenParamSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  pattern: z.string().optional(),
  maxLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  optional: z.boolean().optional(),
});
export type ScreenParam = z.infer<typeof screenParamSchema>;
export const screenActionSchema = z.object({
  name: nameSchema,
  description: z.string().optional(),
  shell: z.enum(['powershell', 'bash']),
  script: z.string(),
  params: z.record(z.string(), screenParamSchema).optional(),
  // Seconds; an action without one runs until it ends.
  timeout: z.number().int().positive().optional(),
});
export type ScreenAction = z.infer<typeof screenActionSchema>;
export const screenDetailSchema = screenSummarySchema.extend({
  html: z.string(),
  actions: z.array(screenActionSchema),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ScreenDetail = z.infer<typeof screenDetailSchema>;

export const screenOutcomeSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type ScreenOutcome = z.infer<typeof screenOutcomeSchema>;

/** The card a reply shows for a screen it saved: its metadata, never the screen. */
export const screenCardSchema = z.object({
  id: screenIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z
    .string()
    .min(1)
    .refine((s) => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s)),
  environmentId: z.string().uuid(),
});
export type ScreenCard = z.infer<typeof screenCardSchema>;
export const screenCardsSchema = z
  .array(screenCardSchema)
  .refine((cards) => new Set(cards.map((card) => card.id)).size === cards.length);

/** A reply's cards, each screen at its newest revision. */
export function mergeScreenCards(left: ScreenCard[] = [], right: ScreenCard[] = []) {
  const result = [...left];
  for (const card of right) {
    const index = result.findIndex((known) => known.id === card.id);
    if (index >= 0) {
      if (result[index].revision < card.revision) result[index] = card;
    } else result.push(card);
  }
  return result;
}

/** What a screen's page asks of the window that shows it. */
export type ScreenCall =
  | { id: number; method: 'run'; action: string; params: Record<string, unknown> }
  | { id: number; method: 'load'; key: string }
  | { id: number; method: 'save'; key: string; value: unknown }
  | { id: number; method: 'chat'; text: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keyOf = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;

/**
 * A page's message, if it is a call of this frame's bridge in a shape the window accepts. The
 * host still checks every value against the screen it keeps.
 */
export function screenCall(data: unknown, token: string): ScreenCall | undefined {
  if (!plainObject(data) || data.type !== 'studio-screen' || data.token !== token) return;
  const id = data.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return;
  if (data.method === 'run') {
    const params = data.params ?? {};
    if (typeof data.action !== 'string' || !nameSchema.safeParse(data.action).success) return;
    if (!plainObject(params) || json(params) === undefined) return;
    return { id, method: 'run', action: data.action, params };
  }
  if (data.method === 'load') {
    const key = keyOf(data.key);
    return key ? { id, method: 'load', key } : undefined;
  }
  if (data.method === 'save') {
    const key = keyOf(data.key);
    const value = data.value === undefined ? null : data.value;
    if (!key || json(value) === undefined) return;
    return { id, method: 'save', key, value };
  }
  if (data.method === 'chat') {
    if (typeof data.text !== 'string' || !data.text.trim()) return;
    return { id, method: 'chat', text: data.text };
  }
}

/** The answer a frame's bridge resolves or rejects its call with. */
export function screenReply(
  token: string,
  id: number,
  result: { value: unknown } | { error: string },
) {
  return 'error' in result
    ? { type: 'studio-screen-reply', token, id, ok: false, error: result.error }
    : { type: 'studio-screen-reply', token, id, ok: true, value: result.value };
}

/** The bridge every screen's page starts with: the global `studio` object (docs/SCREENS.md). */
function bridge(token: string, theme: 'dark' | 'light', screen: { id: string; title: string }) {
  // JSON in a script element: escape what could end it or start markup.
  const literal = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  return `(() => {
const token = ${literal(token)};
const pending = new Map();
let next = 0;
addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || !data || data.type !== 'studio-screen-reply' || data.token !== token) return;
  const call = pending.get(data.id);
  if (!call) return;
  pending.delete(data.id);
  if (data.ok) call.resolve(data.value);
  else call.reject(new Error(typeof data.error === 'string' ? data.error : 'Agent Studio could not answer.'));
});
const ask = (method, args) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  parent.postMessage(Object.assign({ type: 'studio-screen', token, id, method }, args), '*');
});
const studio = {
  theme: ${literal(theme)},
  screen: Object.freeze(${literal(screen)}),
  run: (name, params) => ask('run', { action: name, params: params == null ? {} : params }),
  async json(name, params) {
    const result = await studio.run(name, params);
    if (result.timedOut) throw new Error(name + ' stopped at its time limit.');
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim() || name + ' ended with exit code ' + result.exitCode + '.');
    try { return JSON.parse(result.stdout); } catch { throw new Error(name + ' did not print JSON.'); }
  },
  load: (key) => ask('load', { key }),
  save: (key, value) => ask('save', { key, value: value === undefined ? null : value }),
  chat: (text) => ask('chat', { text }),
};
Object.defineProperty(window, 'studio', { value: Object.freeze(studio), enumerable: true });
})();`;
}

// The host's theme variables, as visualizations receive them (src/lib/visualizations.ts).
const screenThemes = {
  dark: 'color-scheme:dark;--foreground:#dadade;--heading:#ececee;--card:#1c1c1f;--muted-foreground:#8b8b94;--border:#2e2e33;--primary:#c4e88c;--primary-foreground:#172107;--viz-series-1:#c4e88c;--viz-series-2:#85cfc4;--viz-series-3:#ebb57c;--viz-series-4:#b9a6e6;--viz-series-5:#e5a1b1;--viz-series-6:#8fbdf0',
  light:
    'color-scheme:light;--foreground:#27272a;--heading:#18181b;--card:#f4f4f5;--muted-foreground:#6b6b76;--border:#e2e2e6;--primary:#5f9a1f;--primary-foreground:#ffffff;--viz-series-1:#5f9a1f;--viz-series-2:#178f82;--viz-series-3:#d27a22;--viz-series-4:#7657c4;--viz-series-5:#cc4a6e;--viz-series-6:#3478d0',
};

/**
 * A screen's page as its sandboxed frame receives it: the theme, gentle page defaults the page
 * may override, the bridge, then the page itself, which may be a fragment or a whole document.
 */
export function screenDocument(
  source: string,
  token: string,
  screen: { id: string; title: string },
  theme: 'dark' | 'light' = 'dark',
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{${screenThemes[theme]};--background:transparent;--card-foreground:var(--foreground);--muted:var(--card);--secondary:var(--card);--secondary-foreground:var(--foreground);--accent:var(--card);--accent-foreground:var(--foreground);--font-size-base:14px}
*{box-sizing:border-box}html,body{background:transparent}body{margin:0;padding:20px 24px 32px;color:var(--foreground);font:14px/1.6 'Geist Variable',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}h1,h2,h3{color:var(--heading);line-height:1.25;letter-spacing:-.011em}h1{font-size:21px}h2{font-size:18px}h3{font-size:15.5px}a{color:var(--primary)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;padding:5px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px}input,select,textarea{padding:5px 8px;background:transparent;border:1px solid var(--border);border-radius:8px}table{border-collapse:collapse}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{color:var(--muted-foreground);font-weight:500}code,pre{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}svg,canvas,img{max-width:100%}:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
</style><script>${bridge(token, theme, screen)}</script></head><body>${source}</body></html>`;
}

/** Where a screen's actions run, as a list names it. */
export function screenFolderName(screen: Pick<ScreenSummary, 'project' | 'folder'>): string {
  const path = screen.project || '';
  if (!path) return 'Standalone';
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || path;
}
