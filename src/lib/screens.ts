import { z } from 'zod';

/**
 * Screens (docs/SCREENS.md): lasting pages a chat saves in Agent Studio, kept on the computer
 * that runs their commands (src-tauri/src/screens.rs). Nothing here reaches the workspace: windows
 * read a screen, run its actions and commands as jobs and call its MCP tools through transport,
 * and a reply keeps only the card of each screen it saved. Nothing waits for an approval.
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
const controls = /[\u0000-\u001f\u007f]/;
/** A server's or a tool's name, as a screen declares it: one line as written. */
const toolName = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && value.trim() === value && !controls.test(value)
    ? value
    : undefined;
const toolNameSchema = z.string().refine((name) => toolName(name) !== undefined);
/** A place of the screen's computer: `windows`, `wsl` or a WSL distribution's name. */
const placeOf = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value.trim()) ? value.trim() : undefined;
const placeSchema = z.string().refine((place) => placeOf(place) !== undefined);
/** An account a page names, by the name Connections gives it: one line. */
const accountOf = (value: unknown) =>
  typeof value === 'string' && value.trim() && !controls.test(value) ? value.trim() : undefined;
const accountSchema = z.string().refine((account) => accountOf(account) !== undefined);
const shellSchema = z.enum(['powershell', 'bash']);
const commandSchema = z
  .object({
    shell: shellSchema,
    script: z.string().refine((script) => !!script.trim() && !script.includes('\u0000')),
    where: placeSchema.optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();
const paramsSchema = z.record(nameSchema, z.unknown());

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
      params: paramsSchema.optional(),
    })
    .strict()
    .refine((request) => json(request.params ?? {}) !== undefined),
  z
    .object({
      op: z.literal('start'),
      id: screenIdSchema,
      action: nameSchema.optional(),
      command: commandSchema.optional(),
      params: paramsSchema.optional(),
      keep: z.boolean().optional(),
    })
    .strict()
    .refine(
      (request) =>
        !!request.action !== !!request.command && json(request.params ?? {}) !== undefined,
    ),
  z.object({ op: z.literal('jobs'), id: screenIdSchema }).strict(),
  z
    .object({
      op: z.literal('output'),
      id: screenIdSchema,
      job: screenIdSchema,
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      wait: z.boolean().optional(),
      peek: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal('stop'), id: screenIdSchema, job: screenIdSchema }).strict(),
  z.object({ op: z.literal('forget'), id: screenIdSchema, job: screenIdSchema }).strict(),
  z
    .object({
      op: z.literal('mcp'),
      id: screenIdSchema,
      server: toolNameSchema,
      tool: toolNameSchema,
      arguments: z.record(z.string(), z.unknown()).optional(),
      where: placeSchema.optional(),
      account: accountSchema.optional(),
    })
    .strict()
    .refine((request) => json(request.arguments ?? {}) !== undefined),
  z
    .object({
      op: z.literal('tools'),
      id: screenIdSchema,
      where: placeSchema.optional(),
      account: accountSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('ask'),
      id: screenIdSchema,
      prompt: z.string().refine((prompt) => !!prompt.trim()),
      model: z
        .string()
        .regex(/^[^\s\u0000-\u001f\u007f]+$/)
        .optional(),
      system: z.string().optional(),
    })
    .strict(),
  // Windows of releases that asked for an approval still send these; the host answers each
  // with the screen.
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
        .refine((key) => !controls.test(key)),
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
  // How many MCP tools it declares; hosts before MCP tools report none.
  tools: z.number().int().nonnegative().optional(),
  // Hosts of releases that asked for an approval report whether it was given.
  allowed: z.boolean().optional(),
  // How many of its jobs run now; hosts before jobs report none.
  running: z.number().int().nonnegative().optional(),
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
  shell: shellSchema,
  script: z.string(),
  params: z.record(z.string(), screenParamSchema).optional(),
  // Seconds; an action without one runs until it ends.
  timeout: z.number().int().positive().optional(),
  where: z.string().optional(),
});
export type ScreenAction = z.infer<typeof screenActionSchema>;
/** An MCP tool a screen's page calls, where and as which account it names. */
export const screenToolSchema = z.object({
  server: z.string(),
  tool: z.string(),
  description: z.string().optional(),
  where: z.string().optional(),
  account: z.string().optional(),
});
export type ScreenTool = z.infer<typeof screenToolSchema>;
export const screenDetailSchema = screenSummarySchema.extend({
  html: z.string(),
  actions: z.array(screenActionSchema),
  mcpTools: z.array(screenToolSchema).default([]),
  // The account whose CLI calls its tools first; no connection is its computer's own CLI login.
  account: z
    .object({ provider: z.string(), connectionId: z.string().nullable().optional() })
    .optional(),
  digest: z.string().optional(),
});
export type ScreenDetail = z.infer<typeof screenDetailSchema>;
/** What an MCP tool returned: its content blocks, and its structured result when it has one. */
export const screenToolResultSchema = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
  // The account that answered; hosts before places report none.
  account: z.string().optional(),
});
export type ScreenToolResult = z.infer<typeof screenToolResultSchema>;
/** The MCP servers an account has in a place, with their state and tools. */
export const screenServersSchema = z.object({
  account: z.string(),
  accounts: z.array(z.string()),
  servers: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      tools: z.array(z.record(z.string(), z.unknown())),
      error: z.string().optional(),
    }),
  ),
});
export type ScreenServers = z.infer<typeof screenServersSchema>;

export const screenOutcomeSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  stopped: z.boolean().optional(),
  durationMs: z.number().nonnegative(),
  job: z.string().optional(),
});
export type ScreenOutcome = z.infer<typeof screenOutcomeSchema>;

/** A job a screen runs on its computer: an action or a command, with how it ended. */
export const screenJobSchema = z.object({
  id: screenIdSchema,
  action: z.string().optional(),
  label: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  where: z.string().optional(),
  keep: z.boolean(),
  state: z.enum(['running', 'done', 'stopped', 'interrupted', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  bytes: z.number().nonnegative().optional(),
});
export type ScreenJob = z.infer<typeof screenJobSchema>;
/** A job's output from where a reader stopped, in the order its streams printed it. */
export const screenOutputSchema = z.object({
  chunks: z.array(z.object({ stream: z.enum(['stdout', 'stderr']), text: z.string() })),
  next: z.number().int().nonnegative(),
  job: screenJobSchema,
});
export type ScreenOutput = z.infer<typeof screenOutputSchema>;

/** The card a reply shows for a screen it saved: its metadata, never the screen. */
export const screenCardSchema = z.object({
  id: screenIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z
    .string()
    .min(1)
    .refine((s) => !!s.trim() && !controls.test(s)),
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

/** A command a page passes to run as it is (`studio.exec`, `studio.start`). */
export type ScreenCommand = z.infer<typeof commandSchema>;
/** Where a page asks for an MCP call, and as which account. */
type Reach = { where?: string; account?: string };

/** What a screen's page asks of the window that shows it. */
export type ScreenCall = { id: number } & (
  | {
      method: 'start';
      action?: string;
      command?: ScreenCommand;
      params: Record<string, unknown>;
      keep: boolean;
    }
  | { method: 'jobs' }
  | { method: 'output'; job: string; after: number; wait: boolean }
  | { method: 'stop'; job: string }
  | { method: 'forget'; job: string }
  | ({ method: 'mcp'; server: string; tool: string; arguments: Record<string, unknown> } & Reach)
  | ({ method: 'servers' } & Reach)
  | { method: 'ask'; prompt: string; model?: string; system?: string }
  | { method: 'load'; key: string }
  | { method: 'save'; key: string; value: unknown }
  | { method: 'chat'; text: string; send: boolean }
  | { method: 'copy'; text: string }
  | { method: 'open'; url: string }
);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keyOf = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && !controls.test(value) ? value : undefined;
/** A page's optional place and account: absent, or valid. */
function reach(data: Record<string, unknown>): Reach | undefined {
  const result: Reach = {};
  if (data.where != null) {
    const where = placeOf(data.where);
    if (!where) return;
    result.where = where;
  }
  if (data.account != null) {
    const account = accountOf(data.account);
    if (!account) return;
    result.account = account;
  }
  return result;
}

/**
 * A page's message, if it is a call of this frame's bridge in a shape the window accepts. The
 * host still checks every value against the screen it keeps.
 */
export function screenCall(data: unknown, token: string): ScreenCall | undefined {
  if (!plainObject(data) || data.type !== 'studio-screen' || data.token !== token) return;
  const id = data.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return;
  const job = typeof data.job === 'string' && screenIdSchema.safeParse(data.job).success;
  switch (data.method) {
    case 'start': {
      const params = data.params ?? {};
      if (!plainObject(params) || json(params) === undefined) return;
      const keep = data.keep === true;
      if (typeof data.action === 'string' && data.command == null) {
        if (!nameSchema.safeParse(data.action).success) return;
        return { id, method: 'start', action: data.action, params, keep };
      }
      const command = commandSchema.safeParse(data.command);
      if (data.action != null || !command.success) return;
      return { id, method: 'start', command: command.data, params, keep };
    }
    case 'jobs':
      return { id, method: 'jobs' };
    case 'output': {
      const after = data.after ?? 0;
      if (!job || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return;
      return { id, method: 'output', job: data.job as string, after, wait: data.wait === true };
    }
    case 'stop':
    case 'forget':
      return job ? { id, method: data.method, job: data.job as string } : undefined;
    case 'mcp': {
      const [server, tool] = [toolName(data.server), toolName(data.tool)];
      const args = data.arguments ?? {};
      const where = reach(data);
      if (!server || !tool || !where || !plainObject(args) || json(args) === undefined) return;
      return { id, method: 'mcp', server, tool, arguments: args, ...where };
    }
    case 'servers': {
      const where = reach(data);
      return where ? { id, method: 'servers', ...where } : undefined;
    }
    case 'ask': {
      if (typeof data.prompt !== 'string' || !data.prompt.trim()) return;
      const model =
        typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined;
      if (data.model != null && data.model !== '' && (!model || /\s|[\u0000-\u001f]/.test(model)))
        return;
      const system =
        typeof data.system === 'string' && data.system.trim() ? data.system : undefined;
      return { id, method: 'ask', prompt: data.prompt, model, system };
    }
    case 'load': {
      const key = keyOf(data.key);
      return key ? { id, method: 'load', key } : undefined;
    }
    case 'save': {
      const key = keyOf(data.key);
      const value = data.value === undefined ? null : data.value;
      if (!key || json(value) === undefined) return;
      return { id, method: 'save', key, value };
    }
    case 'chat':
      if (typeof data.text !== 'string' || !data.text.trim()) return;
      return { id, method: 'chat', text: data.text, send: data.send === true };
    case 'copy':
      return typeof data.text === 'string' ? { id, method: 'copy', text: data.text } : undefined;
    case 'open':
      return typeof data.url === 'string' && /^https?:\/\/\S+$/i.test(data.url)
        ? { id, method: 'open', url: data.url }
        : undefined;
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

/** What the window tells a page whose theme changed, without loading the page again. */
export function screenTheme(token: string, theme: 'dark' | 'light') {
  return { type: 'studio-screen-theme', token, theme };
}

// The host's theme variables, as visualizations receive them (src/lib/visualizations.ts).
const screenThemes = {
  dark: 'color-scheme:dark;--foreground:#dadade;--heading:#ececee;--card:#1c1c1f;--muted-foreground:#8b8b94;--border:#2e2e33;--primary:#c4e88c;--primary-foreground:#172107;--viz-series-1:#c4e88c;--viz-series-2:#85cfc4;--viz-series-3:#ebb57c;--viz-series-4:#b9a6e6;--viz-series-5:#e5a1b1;--viz-series-6:#8fbdf0',
  light:
    'color-scheme:light;--foreground:#27272a;--heading:#18181b;--card:#f4f4f5;--muted-foreground:#6b6b76;--border:#e2e2e6;--primary:#5f9a1f;--primary-foreground:#ffffff;--viz-series-1:#5f9a1f;--viz-series-2:#178f82;--viz-series-3:#d27a22;--viz-series-4:#7657c4;--viz-series-5:#cc4a6e;--viz-series-6:#3478d0',
};

/** The bridge every screen's page starts with: the global `studio` object (docs/SCREENS.md). */
function bridge(
  token: string,
  theme: 'dark' | 'light',
  screen: { id: string; title: string },
  values: Record<string, unknown>,
  shell: 'powershell' | 'bash',
) {
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
const themes = ${literal(screenThemes)};
let theme = ${literal(theme)};
const pending = new Map();
let next = 0;
addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || !data || data.token !== token) return;
  if (data.type === 'studio-screen-theme' && themes[data.theme]) {
    theme = data.theme;
    const style = document.getElementById('studio-theme');
    if (style) style.textContent = ':root{' + themes[theme] + '}';
    dispatchEvent(new CustomEvent('studio-theme', { detail: theme }));
    return;
  }
  if (data.type !== 'studio-screen-reply') return;
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
const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\\n');
const reachOf = (options) => {
  const reach = {};
  if (options && options.where != null) reach.where = options.where;
  if (options && options.account != null) reach.account = options.account;
  return reach;
};
// Follows a job's output from its start until it ended, as run resolves it.
async function follow(id, options) {
  const onOutput = options && typeof options.onOutput === 'function' ? options.onOutput : null;
  let after = 0, stdout = '', stderr = '';
  for (;;) {
    const answer = await ask('output', { job: id, after, wait: true });
    for (const chunk of answer.chunks) {
      if (chunk.stream === 'stderr') stderr += chunk.text;
      else stdout += chunk.text;
      if (onOutput) {
        try { onOutput(chunk.text, chunk.stream); } catch (error) { console.error(error); }
      }
    }
    after = answer.next;
    const job = answer.job;
    if (job.state === 'running') continue;
    if (job.state === 'failed') throw new Error(job.error || 'This command could not run.');
    return {
      exitCode: job.exitCode == null ? null : job.exitCode,
      stdout,
      stderr,
      truncated: false,
      timedOut: !!job.timedOut,
      stopped: job.state === 'stopped' || job.state === 'interrupted',
      durationMs: job.durationMs || 0,
      job: id,
    };
  }
}
// Starts a job a page waits for, which goes once the page has its end.
async function runJob(request, options) {
  const job = await ask('start', Object.assign({}, request, { keep: false }));
  const signal = options && options.signal;
  const stop = () => { ask('stop', { job: job.id }).catch(() => {}); };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  try {
    return await follow(job.id, options);
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
  }
}
const commandOf = (script, options) => {
  const o = options || {};
  // Where it runs decides the shell a command names none of: bash in WSL.
  const own = ${literal(shell)};
  const elsewhere = o.where != null && String(o.where).toLowerCase() !== 'windows';
  const command = { shell: o.shell || (elsewhere ? 'bash' : own), script: String(script) };
  if (o.where != null) command.where = o.where;
  if (o.timeout != null) command.timeout = o.timeout;
  return command;
};
const studio = {
  get theme() { return theme; },
  screen: Object.freeze(${literal(screen)}),
  values: ${literal(values)},
  run: (name, params, options) => runJob({ action: name, params: params == null ? {} : params }, options),
  async json(name, params, options) {
    const result = await studio.run(name, params, options);
    if (result.timedOut) throw new Error(name + ' stopped at its time limit.');
    if (result.stopped) throw new Error(name + ' was stopped.');
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim() || name + ' ended with exit code ' + result.exitCode + '.');
    try { return JSON.parse(result.stdout); } catch { throw new Error(name + ' did not print JSON.'); }
  },
  exec: (script, options) => runJob({ command: commandOf(script, options), params: (options && options.params) || {} }, options),
  start(what, params) {
    if (what && typeof what === 'object') {
      return ask('start', { command: commandOf(what.script, what), params: what.params || {}, keep: true });
    }
    return ask('start', { action: what, params: params == null ? {} : params, keep: true });
  },
  jobs: () => ask('jobs', {}),
  follow: (id, options) => follow(id, options),
  stop: (id) => ask('stop', { job: id }),
  forget: (id) => ask('forget', { job: id }),
  async mcp(server, tool, args, options) {
    const result = await ask('mcp', Object.assign({ server, tool, arguments: args == null ? {} : args }, reachOf(options)));
    return Object.assign({}, result, { text: textOf(result.content) });
  },
  async mcpJson(server, tool, args, options) {
    const result = await studio.mcp(server, tool, args, options);
    if (result.structuredContent != null) return result.structuredContent;
    try { return JSON.parse(result.text); } catch { throw new Error(tool + ' did not return JSON.'); }
  },
  mcpServers: (options) => ask('servers', reachOf(options)),
  async ask(prompt, options) {
    const o = options || {};
    const request = { prompt: String(prompt) };
    if (o.model) request.model = o.model;
    if (o.system) request.system = o.system;
    const answer = await ask('ask', request);
    if (!o.json) return answer;
    const text = String(answer).trim().replace(/^\\x60\\x60\\x60(?:json)?\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60$/, '$1');
    try { return JSON.parse(text); } catch { throw new Error('The model did not answer with JSON.'); }
  },
  load: (key) => ask('load', { key }),
  async save(key, value) {
    const saved = value === undefined ? null : value;
    await ask('save', { key, value: saved });
    if (saved === null) delete studio.values[key];
    else studio.values[key] = saved;
  },
  copy: (text) => ask('copy', { text: String(text) }),
  open: (url) => ask('open', { url: String(url) }),
  chat: (text, options) => ask('chat', { text, send: !!(options && options.send) }),
};
Object.defineProperty(window, 'studio', { value: Object.freeze(studio), enumerable: true });
})();`;
}

/**
 * A screen's page as its sandboxed frame receives it: the theme, gentle page defaults the page
 * may override, the bridge with the values the screen keeps and the shell its commands run in
 * unless they name one, then the page itself, which may be a fragment or a whole document.
 */
export function screenDocument(
  source: string,
  token: string,
  screen: { id: string; title: string },
  theme: 'dark' | 'light' = 'dark',
  values: Record<string, unknown> = {},
  shell: 'powershell' | 'bash' = 'powershell',
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="studio-theme">:root{${screenThemes[theme]}}</style><style>
:root{--background:transparent;--card-foreground:var(--foreground);--muted:var(--card);--secondary:var(--card);--secondary-foreground:var(--foreground);--accent:var(--card);--accent-foreground:var(--foreground);--font-size-base:14px}
*{box-sizing:border-box}html,body{background:transparent}body{margin:0;padding:20px 24px 32px;color:var(--foreground);font:14px/1.6 'Geist Variable',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}h1,h2,h3{color:var(--heading);line-height:1.25;letter-spacing:-.011em}h1{font-size:21px}h2{font-size:18px}h3{font-size:15.5px}a{color:var(--primary)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;padding:5px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px}input,select,textarea{padding:5px 8px;background:transparent;border:1px solid var(--border);border-radius:8px}table{border-collapse:collapse}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{color:var(--muted-foreground);font-weight:500}code,pre{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}svg,canvas,img{max-width:100%}:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
</style><script>${bridge(token, theme, screen, values, shell)}</script></head><body>${source}</body></html>`;
}

/** Where a screen's actions run, as a list names it. */
export function screenFolderName(screen: Pick<ScreenSummary, 'project' | 'folder'>): string {
  const path = screen.project || '';
  if (!path) return 'Standalone';
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || path;
}

/** How long a job ran, or has run, in the compact form running calls use. */
export function jobDuration(
  job: Pick<ScreenJob, 'startedAt' | 'durationMs' | 'state'>,
  now: number,
) {
  const ms =
    job.state === 'running' || job.durationMs == null
      ? Math.max(0, now - Date.parse(job.startedAt))
      : job.durationMs;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const escape = String.fromCharCode(27);
const bell = String.fromCharCode(7);
// Color and cursor sequences, terminal titles and other escapes a command may print.
const sequences = new RegExp(
  `${escape}\\[[0-?]*[ -/]*[@-~]|${escape}\\][^${bell}${escape}]*(?:${bell}|${escape}\\\\)|${escape}[@-_]`,
  'g',
);
/**
 * Text a command printed as a terminal leaves it: without its escape sequences, and each line as
 * its last carriage return redrew it.
 */
export function terminalText(text: string): string {
  return text
    .replace(sequences, '')
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r$/, '').split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
}
