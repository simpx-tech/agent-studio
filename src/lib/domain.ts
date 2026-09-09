import { z } from 'zod';
import { emptyFleet, fleetSchema } from './fleet.ts';
import { toolActivitySchema, type ToolActivity } from './activity';

export const providerIds = ['codex', 'claude', 'gemini'] as const;
export type ProviderId = (typeof providerIds)[number];
export const providers = {
  codex: {
    name: 'Codex',
    company: 'OpenAI',
    account: 'ChatGPT',
    mark: 'O',
    color: '#b9ddcc',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    description: 'A thoughtful partner for ideas, code, and problem solving.',
  },
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    account: 'Claude',
    mark: '✳',
    color: '#dda987',
    install: 'irm https://claude.ai/install.ps1 | iex',
    login: 'claude auth login',
    description: 'Go from a rough thought to something carefully considered.',
  },
  gemini: {
    name: 'Gemini',
    company: 'Google',
    account: 'Google',
    mark: '✦',
    color: '#a9bff0',
    install: 'irm https://antigravity.google/cli/install.ps1 | iex',
    login: 'agy',
    description: 'Explore possibilities and bring a fresh perspective.',
  },
} satisfies Record<
  ProviderId,
  {
    name: string;
    company: string;
    account: string;
    mark: string;
    color: string;
    install: string;
    login: string;
    description: string;
  }
>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  provider: z.enum(providerIds),
  model: z.string().max(100),
  instructions: z.string().max(16000),
  description: z.string().max(180),
});
export type Agent = z.infer<typeof agentSchema>;
export const reasoningSchema = z.enum([
  '',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export type Reasoning = z.infer<typeof reasoningSchema>;
export const chatSettingsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  provider: z.enum(providerIds),
  model: z.string().max(100),
  reasoning: reasoningSchema,
  instructions: z.string().max(16000),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const locationSchema = z.object({
  computerId: z.string().uuid(),
  environmentId: z.string().uuid(),
  // Folder ownership and CLI execution can differ for Desktop + a WSL folder.
  executionEnvironmentId: z.string().uuid().optional(),
  path: z.string().max(4096),
});
export type ChatLocation = z.infer<typeof locationSchema>;
export const preferencesSchema = z.object({
  recentLocations: z.array(locationSchema).max(30).optional(),
  connectionByProvider: z.partialRecord(z.enum(providerIds), z.string().uuid()).optional(),
  lastProvider: z.enum(providerIds),
  modelByProvider: z.partialRecord(z.enum(providerIds), z.string().max(100)),
  reasoningByProvider: z.partialRecord(z.enum(providerIds), z.record(z.string(), reasoningSchema)),
});
export type Preferences = z.infer<typeof preferencesSchema>;
const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({
    type: z.literal('activity'),
    text: z.string(),
    tool: toolActivitySchema.optional(),
    progress: z
      .object({ id: z.string().max(240), revision: z.number().int().nonnegative() })
      .optional(),
    order: z.number().int().nonnegative().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof blockSchema>;
const tokenCount = z.number().nonnegative().nullable().optional();
export const tokenUsageSchema = z.object({
  input: tokenCount,
  output: tokenCount,
  cachedInput: tokenCount,
  reasoningOutput: tokenCount,
  contextInput: tokenCount,
  contextWindow: tokenCount,
  costUsd: z.number().nonnegative().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export const messageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(blockSchema),
  status: z.enum(['complete', 'running', 'error', 'cancelled']),
  createdAt: z.string(),
  error: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  promptTokensEstimate: z.number().nonnegative().optional(),
  durationMs: z.number().optional(),
  settings: chatSettingsSchema.optional(),
  modelName: z.string().max(200).optional(),
  authorName: z.string().optional(),
  executionLabel: z.string().optional(),
  runId: z.string().uuid().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  id: z.string().uuid(),
  location: locationSchema.optional(),
  archived: z.boolean().optional(),
  settings: chatSettingsSchema,
  title: z.string().max(100),
  titleStatus: z.enum(['pending', 'generated', 'fallback']).optional(),
  titleSource: z.object({ provider: z.enum(providerIds), model: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const workspaceSchema = z.object({
  version: z.literal(3),
  fleet: fleetSchema,
  preferences: preferencesSchema,
  legacyAgents: z.array(agentSchema).optional(),
  conversations: z.array(conversationSchema),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type ProviderStatus = {
  id: ProviderId;
  installed: boolean;
  version: string | null;
  auth: 'ready' | 'login' | 'unknown';
  detail: string;
  location?: string | null;
};
export type RunEvent = TokenUsage & {
  kind: 'text' | 'activity' | 'usage' | 'error' | 'tool' | 'progress';
  id?: string;
  revision?: number;
  text?: string;
  tool?: ToolActivity;
};
export type RunRequest = {
  location?: ChatLocation;
  conversationId?: string;
  assistantId?: string;
  runId: string;
  agent: ChatSettings;
  messages: { role: 'user' | 'assistant'; text: string }[];
};

export function initialWorkspace(): Workspace {
  return {
    version: 3,
    fleet: emptyFleet(),
    preferences: { lastProvider: 'codex', modelByProvider: {}, reasoningByProvider: {} },
    conversations: [],
  };
}
export const messageText = (message: Message) =>
  message.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n\n');
export function historyFor(conversation: Conversation): RunRequest['messages'] {
  // Interrupted and failed responses never become fabricated assistant history.
  return conversation.messages
    .filter((m) => m.role === 'user' || m.status === 'complete')
    .map((m) => ({ role: m.role, text: messageText(m) }))
    .filter((m) => m.text.trim());
}
export function restoreWorkspace(value: unknown): Workspace {
  const oldSchema = z.object({
    version: z.literal(1),
    agents: z.array(agentSchema).min(1),
    conversations: z.array(
      conversationSchema.omit({ settings: true }).extend({ agent: agentSchema }),
    ),
  });
  let data: Workspace;
  if ((value as { version?: number } | null)?.version === 1) {
    const old = oldSchema.parse(value);
    data = initialWorkspace();
    data.legacyAgents = old.agents;
    data.conversations = old.conversations.map(({ agent, ...conversation }) => {
      const settings = migrateSettings(agent);
      return {
        ...conversation,
        settings,
        messages: conversation.messages.map((message) => ({
          ...message,
          ...(message.role === 'assistant'
            ? { settings: { ...settings }, authorName: agent.name }
            : {}),
        })),
      };
    });
    for (const agent of old.agents) rememberSettings(data.preferences, migrateSettings(agent));
    for (const conversation of [...data.conversations].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    ))
      rememberSettings(data.preferences, conversation.settings);
  } else if ((value as { version?: number } | null)?.version === 2) {
    const old = workspaceSchema
      .omit({ version: true, fleet: true })
      .extend({ version: z.literal(2) })
      .parse(value);
    data = workspaceSchema.parse({ ...old, version: 3, fleet: emptyFleet() });
  } else data = workspaceSchema.parse(value);
  for (const c of data.conversations) {
    if (c.titleStatus === 'pending') c.titleStatus = 'fallback';
    for (const m of c.messages)
      if (m.status === 'running') {
        m.status = 'cancelled';
        m.error = 'This response was interrupted when the app closed.';
      }
  }
  return data;
}

function migrateSettings(agent: Agent): ChatSettings {
  let model = agent.model;
  let reasoning: Reasoning = '';
  if (agent.provider === 'gemini') {
    const match = model.match(/^(gemini-.+)-(low|medium|high)$/);
    model = match?.[1] ?? (model || 'gemini-3.8-flash');
    reasoning = (match?.[2] as Reasoning) ?? (model.includes('-pro') ? 'high' : 'medium');
  }
  return { provider: agent.provider, model, reasoning, instructions: agent.instructions };
}

export function rememberSettings(preferences: Preferences, settings: ChatSettings) {
  if (settings.connectionId)
    preferences.connectionByProvider = {
      ...preferences.connectionByProvider,
      [settings.provider]: settings.connectionId,
    };
  else if (preferences.connectionByProvider)
    delete preferences.connectionByProvider[settings.provider];
  preferences.lastProvider = settings.provider;
  preferences.modelByProvider[settings.provider] = settings.model;
  preferences.reasoningByProvider[settings.provider] = {
    ...preferences.reasoningByProvider[settings.provider],
    [settings.model]: settings.reasoning,
  };
}

export function settingsFor(
  preferences: Preferences,
  provider = preferences.lastProvider,
): ChatSettings {
  const model =
    preferences.modelByProvider[provider] ?? (provider === 'gemini' ? 'gemini-3.8-flash' : '');
  return {
    ...(preferences.connectionByProvider?.[provider]
      ? { connectionId: preferences.connectionByProvider[provider] }
      : {}),
    provider,
    model,
    reasoning:
      preferences.reasoningByProvider[provider]?.[model] ?? (provider === 'gemini' ? 'medium' : ''),
    instructions: '',
  };
}
