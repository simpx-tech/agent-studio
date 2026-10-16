import type { ProviderId, Reasoning } from './domain';

export type ModelInfo = {
  id: string;
  name: string;
  reasoningLevels: Reasoning[];
  defaultReasoning: Reasoning;
  contextWindow?: number | null;
  contextSource?: string | null;
  // The model offers Fast mode (Claude's `supportsFastMode`, a Codex Fast service tier), what
  // the CLI says it gives, and why Claude says the account cannot use it (`fastModeBlock`).
  fastMode?: boolean;
  fastModeDetail?: string;
  fastModeBlocked?: string;
};
export type ModelCatalog = Record<ProviderId, ModelInfo[]>;
export const automaticModel: ModelInfo = {
  id: '',
  name: 'CLI default',
  reasoningLevels: [],
  defaultReasoning: '',
};
export const fallbackModels: ModelCatalog = {
  codex: [automaticModel],
  claude: [
    automaticModel,
    // The selected CLI decides which model an alias means; its catalog names that model.
    ...['opus', 'sonnet', 'fable', 'haiku'].map((id): ModelInfo => ({
      id,
      name: `${id[0].toUpperCase()}${id.slice(1)}`,
      reasoningLevels: id === 'haiku' ? [] : ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoning: '',
    })),
  ],
  gemini: [
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      reasoningLevels: ['low', 'medium', 'high'],
      defaultReasoning: 'medium',
    },
  ],
};
export function modelChoices(
  catalog: ModelCatalog,
  provider: ProviderId,
  current: string,
): ModelInfo[] {
  const models = catalog[provider];
  return models.some((model) => model.id === current)
    ? models
    : [
        ...models,
        { id: current, name: current || 'CLI default', reasoningLevels: [], defaultReasoning: '' },
      ];
}
// Reasoning levels from the least to the most.
const reasoningOrder: Reasoning[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
// A model's levels as the Reasoning slider's stops: Default, then each level from the least to
// the most, a chat's level the model no longer lists among them in its place.
export function reasoningScale(levels: string[], current: Reasoning): Reasoning[] {
  const listed = new Set<string>([...levels, current]);
  return ['', ...reasoningOrder.filter((level) => listed.has(level))];
}
// Claude's own words for the reasons it gives that last until the account changes.
const fastModeBlocks: Record<string, string> = {
  extra_usage_disabled: 'Fast mode requires usage credits',
  free: 'Fast mode requires a paid subscription',
  preference: 'Fast mode has been disabled by your organization',
};
export const fastModeBlock = (model: ModelInfo) =>
  model.fastModeBlocked ? fastModeBlocks[model.fastModeBlocked] : undefined;
// The Fast toggle's hover: why the account cannot use it, else what it gives at what cost.
export const fastModeTitle = (model: ModelInfo) =>
  fastModeBlock(model) ??
  `Fast mode · ${model.fastModeDetail ?? 'Faster replies at a higher cost'}`;
export const reasoningName = (level: Reasoning) =>
  ({
    '': 'Default',
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
    ultra: 'Ultra',
  })[level];
