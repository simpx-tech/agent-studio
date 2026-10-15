import type { ProviderId, Reasoning } from './domain';

export type ModelInfo = {
  id: string;
  name: string;
  reasoningLevels: Reasoning[];
  defaultReasoning: Reasoning;
  contextWindow?: number | null;
  contextSource?: string | null;
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
