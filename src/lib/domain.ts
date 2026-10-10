import { z } from 'zod';
import { fallbackModelSetting } from './claude-options.ts';
import { outputSchemaSetting } from './structured-output.ts';
import { mentionSchema, type Mention } from './mentions.ts';
import { compactionsSchema, type Compaction } from './compaction.ts';
import { accountUsageSchema, type AccountUsage } from './spend.ts';
import { emptyFleet, fleetSchema, type Fleet } from './fleet.ts';
import { toolActivitySchema, type ToolActivity } from './activity.ts';
import { imageSchema, type ChatImage } from './images.ts';
import { planSchema, type Plan } from './plans.ts';
import { proposedPlansSchema, proposedPlanHistory, type ProposedPlan } from './proposed-plans.ts';
import { visualizationsSchema, type Visualization } from './visualizations.ts';
import { sentFileGroupsSchema, type SentFiles } from './sent-files.ts';
import { screenCardsSchema, type ScreenCard } from './screens.ts';
import { fileChangesSchema, type FileChanges } from './file-changes.ts';
import { reasoningBlockSchema } from './reasoning.ts';
import { questionsSchema, questionHistory, type QuestionRequest } from './questions.ts';
import type { QuestionDraft } from './question-drafts.ts';
import { elicitationReceiptsSchema, type ElicitationReceipt } from './elicitations.ts';
import { steeringSchema, steeringHistory, type SteeringReceipt } from './steering.ts';
import { usageLimitSchema, type UsageLimit } from './usage-limits.ts';
import { inputTemplatesSchema } from './input-templates.ts';
import { claudeInstructionsSchema } from './claude-instructions.ts';
import { appSessionsSchema } from './app-sessions.ts';
import { folderIconsSchema } from './folder-icons.ts';
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
  },
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    account: 'Claude',
    mark: '✳',
    color: '#dda987',
    install: 'irm https://claude.ai/install.ps1 | iex',
    login: 'claude auth login',
  },
  gemini: {
    name: 'Gemini',
    company: 'Google',
    account: 'Google',
    mark: '✦',
    color: '#a9bff0',
    install: 'irm https://antigravity.google/cli/install.ps1 | iex',
    login: 'agy',
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
  }
>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  provider: z.enum(providerIds),
  model: z.string(),
  instructions: z.string(),
  description: z.string(),
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
  // Any budget; a provider that accepts less reports its own limit.
  maxThinkingTokens: z.number().int().nonnegative().optional(),
  outputSchema: outputSchemaSetting.optional(),
  planMode: z.boolean().optional(),
  autoCompactTokens: z.number().int().positive().optional(),
  connectionId: z.string().uuid().optional(),
  provider: z.enum(providerIds),
  model: z.string(),
  reasoning: reasoningSchema,
  instructions: z.string(),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const locationSchema = z.object({
  computerId: z.string().uuid(),
  environmentId: z.string().uuid(),
  // Folder ownership and CLI execution can differ for Desktop + a WSL folder.
  executionEnvironmentId: z.string().uuid().optional(),
  path: z.string(),
});
export type ChatLocation = z.infer<typeof locationSchema>;
export const preferencesSchema = z.object({
  recentLocations: z.array(locationSchema).max(30).optional(),
  connectionByProvider: z.partialRecord(z.enum(providerIds), z.string().uuid()).optional(),
  lastProvider: z.enum(providerIds),
  modelByProvider: z.partialRecord(z.enum(providerIds), z.string()),
  reasoningByProvider: z.partialRecord(z.enum(providerIds), z.record(z.string(), reasoningSchema)),
  // Every account each WSL distribution this computer manages has had, so adding its accounts
  // there never brings back one removed there (`addHostAccounts`). Kept on this device only.
  distributionAccounts: z.record(z.string().uuid(), z.array(z.string().uuid())).optional(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
const blockSchema = z.discriminatedUnion('type', [
  reasoningBlockSchema,
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({
    type: z.literal('activity'),
    text: z.string(),
    tool: toolActivitySchema.optional(),
    progress: z.object({ id: z.string(), revision: z.number().int().nonnegative() }).optional(),
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
    .regex(/^[a-zA-Z0-9_:.-]+$/),
  path: z
    .string()
    .min(1)
    .refine((path) => !/[\u0000-\u001f]/.test(path)),
});
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export const messageSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant']),
    blocks: z.array(blockSchema),
    images: z.array(imageSchema).optional(),
    skills: z.array(skillReferenceSchema).optional(),
    mentions: z.array(mentionSchema).optional(),
    status: z.enum(['complete', 'running', 'error', 'cancelled']),
    createdAt: z.string(),
    error: z.string().optional(),
    usage: tokenUsageSchema.optional(),
    accountUsage: accountUsageSchema.optional(),
    promptTokensEstimate: z.number().nonnegative().optional(),
    durationMs: z.number().optional(),
    settings: chatSettingsSchema.optional(),
    modelName: z.string().optional(),
    authorName: z.string().optional(),
    executionLabel: z.string().optional(),
    runId: z.string().uuid().optional(),
    plan: planSchema.optional(),
    proposedPlans: proposedPlansSchema.optional(),
    visualizations: visualizationsSchema.optional(),
    sentFiles: sentFileGroupsSchema.optional(),
    // The screens the reply saved, which their cards open from the computer that keeps them.
    screens: screenCardsSchema.optional(),
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
    // A running Claude reply whose turn ended while background work it waits for continues:
    // the number of that idle stretch, in which the next message takes the reply over.
    backgroundWait: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    // The usage limit that stopped the reply, in the provider's words; never replayed.
    usageLimit: usageLimitSchema.optional(),
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
  )
  .refine(
    (message) =>
      !message.sentFiles?.length ||
      (message.role === 'assistant' &&
        message.sentFiles.every((group) => group.runId === message.runId)),
    { message: 'Shown files do not match their response run' },
  );
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  id: z.string().uuid(),
  // A portable history copy starts a new Standalone folder even with prior messages.
  forked: z.literal(true).optional(),
  location: locationSchema.optional(),
  archived: z.boolean().optional(),
  settings: chatSettingsSchema,
  title: z.string(),
  titleStatus: z.enum(['pending', 'generated', 'fallback']).optional(),
  titleSource: z.object({ provider: z.enum(providerIds), model: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
  historyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  rewind: z
    .object({
      removed: z.array(messageSchema).min(1),
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
  workflows: z.array(workflowSchema).optional(),
  inputTemplates: inputTemplatesSchema.optional(),
  claudeInstructions: claudeInstructionsSchema.optional(),
  // Starts of the desktop app, which History groups chats by.
  appSessions: appSessionsSchema.optional(),
  // The icon a model chose for each project folder.
  folderIcons: folderIconsSchema.optional(),
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
  // The check itself failed, as its detail says, so installation and sign-in are unknown.
  checkFailed?: boolean;
  // Why a separate Claude profile is not sharing this computer's Claude directory yet.
  sharing?: string | null;
  // Windows' one-time permission would let it share settings.json and CLAUDE.md too.
  sharingPermission?: boolean;
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
    | 'sentfiles'
    | 'screen'
    | 'question'
    | 'questiondraft'
    | 'elicitation'
    | 'steering'
    | 'compaction'
    | 'workflow'
    | 'nativeworkflow'
    | 'backgroundwait'
    | 'takeover'
    | 'usagelimit';
  id?: string;
  accountUsage?: AccountUsage;
  revision?: number;
  // The idle stretch a Claude reply waits in for background work, or null once a turn started.
  wait?: number | null;
  text?: string;
  truncated?: boolean;
  tool?: ToolActivity;
  plan?: Plan;
  proposedPlan?: ProposedPlan;
  visualization?: Visualization;
  sentFiles?: SentFiles;
  screen?: ScreenCard;
  question?: QuestionRequest;
  // The call whose draft a recorded question replaces.
  draft?: string;
  questionDraft?: QuestionDraft;
  elicitation?: ElicitationReceipt;
  steering?: SteeringReceipt;
  compaction?: Compaction;
  fileChanges?: FileChanges;
  workflow?: WorkflowProgress;
  nativeWorkflows?: NativeWorkflows;
  usageLimit?: UsageLimit;
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
  // A message sent while the conversation's Claude reply only waits for background work: that
  // reply hands this one its process and ends. `messages` are the user message and the reply
  // placeholder the conversation gains once the host confirms, on the executing host as well.
  takeOver?: { runId: string; wait: number; messages: Message[] };
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
/**
 * A saved workspace, migrated and validated. Replies saved as running were interrupted with the
 * app, unless `followsRuns`: the Viewer runs none, so its reload stops nothing, and it keeps
 * following each one as its computer reports it.
 */
/**
 * A saved workspace, ready to use. Replies saved as running stopped with the app that ran them,
 * so they read as interrupted, unless this device follows runs other computers report (the
 * Viewer), or names the replies it ran itself (`runsHere`, a server, whose restart leaves the
 * replies of other computers running).
 */
export function restoreWorkspace(
  value: unknown,
  {
    followsRuns = false,
    runsHere,
  }: {
    followsRuns?: boolean;
    runsHere?: (conversation: Conversation, message: Message, fleet: Fleet) => boolean;
  } = {},
): Workspace {
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
    if (!followsRuns)
      for (const m of c.messages)
        if (m.status === 'running' && (!runsHere || runsHere(c, m, data.fleet))) {
          m.status = 'cancelled';
          m.error = interruptedReplyError;
          delete m.backgroundWait;
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
