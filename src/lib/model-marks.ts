import { providers, type ProviderId } from './domain';

// Each Claude family has its own tint in theme.css, so two families never share a look.
const claudeFamilies = new Set(['opus', 'sonnet', 'fable', 'haiku', 'mythos']);

/** A model's tile in the Model picker and beside its replies: the version that runs (Opus 5.5
 * shows 5.5) on its family's tint, or the provider's mark when the name has no version, such
 * as CLI default or an alias the CLI has not resolved. */
export type ModelMark = { text: string; color: string; version: boolean };

export function modelMark(provider: ProviderId, name: string): ModelMark {
  const glyph = { text: providers[provider].mark, color: providers[provider].color };
  if (provider === 'claude') {
    // Catalog and reported Claude names read Family or Family 5.5 (see formatModelName).
    const [, family, version] = /^([A-Z][a-z]+)(?: (\d{1,2}(?:\.\d{1,2})*))?$/.exec(name) ?? [];
    const color =
      family && claudeFamilies.has(family.toLowerCase())
        ? `var(--model-${family.toLowerCase()})`
        : glyph.color;
    return version ? { text: version, color, version: true } : { ...glyph, color, version: false };
  }
  // GPT-5.6 Sol shows 5.6 and Gemini 3.8 Flash shows 3.8, on the provider's tint.
  const version = /\d+(?:\.\d+)?/.exec(name)?.[0];
  return version && version.length <= 4
    ? { text: version, color: glyph.color, version: true }
    : { ...glyph, version: false };
}
