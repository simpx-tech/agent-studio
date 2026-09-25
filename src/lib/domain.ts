import { z } from 'zod';
import { fallbackModelSetting } from './claude-options.ts';
import { outputSchemaSetting } from './structured-output.ts';
import { mentionSchema, maxMentions, type Mention } from './mentions.ts';
import { compactionsSchema, type Compaction } from './compaction.ts';
import { accountUsageSchema, type AccountUsage } from './spend.ts';
import { emptyFleet, fleetSchema } from './fleet.ts';
import { toolActivitySchema, type ToolActivity } from './activity.ts';
import { imageSchema, maxImagesPerMessage, type ChatImage } from './images.ts';
import { planSchema, type Plan } from './plans.ts';
import { proposedPlansSchema, proposedPlanHistory, type ProposedPlan } from './proposed-plans.ts';
import { visualizationsSchema, type Visualization } from './visualizations.ts';
import { fileChangesSchema, type FileChanges } from './file-changes.ts';
import { reasoningBlockSchema, maxReasoningBlocks } from './reasoning.ts';
import { questionsSchema, questionHistory, type QuestionRequest } from './questions.ts';
import { elicitationReceiptsSchema, type ElicitationReceipt } from './elicitations.ts';
import { steeringSchema, steeringHistory, type SteeringReceipt } from './steering.ts';
import { inputTemplatesSchema } from './input-templates.ts';
import { claudeInstructionsSchema } from './claude-instructions.ts';
import {
  workflowSchema,
  workflowProgressSchema,
  nativeWorkflowsSchema,
  type NativeWorkflows,
  type WorkflowProgress,
} from './workflows.ts';

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
  fastMode: z.boolean().optional(),
  fallbackModel: fallbackModelSetting.optional(),
  maxThinkingTokens: z
    .number()
    .int()
    .refine((n) => n === 0 || (n >= 1024 && n <= 128_000))
    .optional(),
  outputSchema: outputSchemaSetting.optional(),
  planMode: z.boolean().optional(),
  autoCompactTokens: z.number().int().min(100_000).max(1_000_000).optional(),
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
  reasoningBlockSchema,
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
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  input: tokenCount,
  output: tokenCount,
  cachedInput: tokenCount,
  reasoningOutput: tokenCount,
  contextInput: tokenCount,
  contextWindow: tokenCount,
  costUsd: z.number().nonnegative().nullable().optional(),
  scope: z.enum(['session', 'reply']).optional(),
  sessionCredits: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  sessionCostUsd: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  model: z.string().nullable().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export const skillReferenceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_:.-]+$/),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => !/[\u0000-\u001f]/.test(path)),
});
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export const messageSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant']),
    blocks: z
      .array(blockSchema)
      .refine(
        (blocks) => blocks.filter((b) => b.type === 'reasoning').length <= maxReasoningBlocks,
        'Too many reasoning blocks',
      ),
    images: z.array(imageSchema).max(maxImagesPerMessage).optional(),
    skills: z.array(skillReferenceSchema).max(4).optional(),
    mentions: z.array(mentionSchema).max(maxMentions).optional(),
    status: z.enum(['complete', 'running', 'error', 'cancelled']),
    createdAt: z.string(),
    error: z.string().optional(),
    usage: tokenUsageSchema.optional(),
    accountUsage: accountUsageSchema.optional(),
    promptTokensEstimate: z.number().nonnegative().optional(),
    durationMs: z.number().optional(),
    settings: chatSettingsSchema.optional(),
    modelName: z.string().max(200).optional(),
    authorName: z.string().optional(),
    executionLabel: z.string().optional(),
    runId: z.string().uuid().optional(),
    plan: planSchema.optional(),
    proposedPlans: proposedPlansSchema.optional(),
    visualizations: visualizationsSchema.optional(),
    questions: questionsSchema.optional(),
    elicitations: elicitationReceiptsSchema.optional(),
    steering: steeringSchema.optional(),
    compact: z.boolean().optional(),
    compactions: compactionsSchema.optional(),
    fileChanges: fileChangesSchema.optional(),
    filesUndone: z.boolean().optional(),
    workflow: workflowProgressSchema.optional(),
    workflowDefinition: workflowSchema.optional(),
    nativeWorkflows: nativeWorkflowsSchema.optional(),
  })
  .refine(
    (message) =>
      !message.accountUsage ||
      (message.role === 'assistant' && message.accountUsage.runId === message.runId),
    { message: 'Account observation does not match its response run' },
  )
  .refine(
    (message) =>
      !message.steering?.length ||
      (message.role === 'assistant' && message.steering.every((s) => s.runId === message.runId)),
    { message: 'Steering does not match its response run' },
  )
  .refine(
    (message) =>
      !message.elicitations?.length ||
      (message.role === 'assistant' &&
        message.elicitations.every((e) => e.runId === message.runId)),
    { message: 'MCP input does not match its response run' },
  );
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  id: z.string().uuid(),
  // A portable history copy starts a new Standalone folder even with prior messages.
  forked: z.literal(true).optional(),
  location: locationSchema.optional(),
  archived: z.boolean().optional(),
  settings: chatSettingsSchema,
  title: z.string().max(100),
  titleStatus: z.enum(['pending', 'generated', 'fallback']).optional(),
  titleSource: z.object({ provider: z.enum(providerIds), model: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
  historyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  rewind: z
    .object({
      removed: z.array(messageSchema).min(1).max(200),
      createdAt: z.string(),
    })
    .optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const workspaceSchema = z.object({
  version: z.literal(3),
  fleet: fleetSchema,
  preferences: preferencesSchema,
  legacyAgents: z.array(agentSchema).optional(),
  conversations: z.array(conversationSchema),
  workflows: z.array(workflowSchema).max(100).optional(),
  inputTemplates: inputTemplatesSchema.optional(),
  claudeInstructions: claudeInstructionsSchema.optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type ProviderStatus = {
  id: ProviderId;
  installed: boolean;
  version: string | null;
  auth: 'ready' | 'login' | 'unknown';
  detail: string;
  location?: string | null;
  // Signed-in identity reported by the CLI itself (Claude's account email); session-only metadata.
  account?: string | null;
};
export type RunEvent = TokenUsage & {
  kind:
    | 'skillschanged'
    | 'text'
    | 'activity'
    | 'usage'
    | 'accountusage'
    | 'error'
    | 'tool'
    | 'progress'
    | 'reasoning'
    | 'plan'
    | 'proposedplan'
    | 'filechanges'
    | 'visualization'
    | 'question'
    | 'elicitation'
    | 'steering'
    | 'compaction'
    | 'workflow'
    | 'nativeworkflow';
  id?: string;
  accountUsage?: AccountUsage;
  revision?: number;
  text?: string;
  truncated?: boolean;
  tool?: ToolActivity;
  plan?: Plan;
  proposedPlan?: ProposedPlan;
  visualization?: Visualization;
  question?: QuestionRequest;
  elicitation?: ElicitationReceipt;
  steering?: SteeringReceipt;
  compaction?: Compaction;
  fileChanges?: FileChanges;
  workflow?: WorkflowProgress;
  nativeWorkflows?: NativeWorkflows;
};
export type RunRequest = {
  compact?: boolean;
  location?: ChatLocation;
  conversationId?: string;
  historyRevision?: number;
  assistantId?: string;
  runId: string;
  // An earlier reply in this conversation used another account of the same agent. The
  // host starts a fresh native session for the selected account from the saved messages.
  accountSwitch?: boolean;
  forked?: boolean;
  agent: ChatSettings;
  // Workspace-wide Claude chat instructions, appended to the CLI's system prompt.
  claudeInstructions?: string;
  messages: {
    role: 'user' | 'assistant';
    text: string;
    images?: ChatImage[];
    skills?: SkillReference[];
    mentions?: Mention[];
    visualizations?: Visualization[];
  }[];
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
    .filter(
      (m) =>
        m.role === 'user' ||
        m.status === 'complete' ||
        questionHistory(m.questions) ||
        m.steering?.length,
    )
    .map((m) => ({
      role: m.role === 'assistant' && m.status !== 'complete' ? ('user' as const) : m.role,
      text:
        (m.role === 'assistant' && m.status !== 'complete' ? '' : messageText(m)) +
        (m.filesUndone
          ? '\n\n[The user undid this response’s recorded file edits after the response. Check the current files before continuing.]'
          : '') +
        (m.role === 'assistant'
          ? questionHistory(m.questions) +
            steeringHistory(m.steering) +
            (m.status === 'complete' ? proposedPlanHistory(m.proposedPlans) : '')
          : ''),
      ...(m.role === 'user' && m.images?.length ? { images: m.images } : {}),
      ...(m.role === 'user' && m.skills?.length ? { skills: m.skills } : {}),
      ...(m.role === 'user' && m.mentions?.length ? { mentions: m.mentions } : {}),
      ...(m.role === 'assistant' && m.status === 'complete' && m.visualizations?.length
        ? { visualizations: m.visualizations }
        : {}),
    }))
    .filter((m) => m.text.trim() || m.images?.length || m.visualizations?.length);
}
// Loading a saved workspace cannot regain a run that was live when the app stopped.
export const interruptedReplyError = 'This response was interrupted when the app closed.';
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
    const remember = (settings: ChatSettings) => {
      rememberSettings(data.preferences, settings);
      rememberAgent(data.preferences, settings);
    };
    for (const agent of old.agents) remember(migrateSettings(agent));
    for (const conversation of [...data.conversations].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    ))
      remember(conversation.settings);
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
        m.error = interruptedReplyError;
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

// The model per provider and the reasoning per provider and model, from any chat's settings.
export function rememberSettings(preferences: Preferences, settings: ChatSettings) {
  preferences.modelByProvider[settings.provider] = settings.model;
  preferences.reasoningByProvider[settings.provider] = {
    ...preferences.reasoningByProvider[settings.provider],
    [settings.model]: settings.reasoning,
  };
}
// The agent and account the user last chose, which new chats start with. Replies and other
// settings of existing chats never replace it; a choice without an account keeps the one
// remembered for that agent.
export function rememberAgent(
  preferences: Preferences,
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
) {
  preferences.lastProvider = settings.provider;
  if (settings.connectionId)
    preferences.connectionByProvider = {
      ...preferences.connectionByProvider,
      [settings.provider]: settings.connectionId,
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
