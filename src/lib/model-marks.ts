import { providers, type ProviderId } from './domain';

/** A model line with its own illustration (`ModelIcon.svelte`). */
export type ModelLine =
  | 'haiku'
  | 'sonnet'
  | 'opus'
  | 'fable'
  | 'mythos'
  | 'astra'
  | 'sol'
  | 'luna'
  | 'terra'
  | 'gpt'
  | 'flash'
  | 'pro'
  | 'gemini';

const claudeLines = new Set<ModelLine>(['opus', 'sonnet', 'fable', 'haiku', 'mythos']);
// Lines that share their provider's color instead of a tint of their own in theme.css.
const providerTinted = new Set<ModelLine>(['gpt', 'gemini']);

/** A model's mark in the Model picker and beside its replies: its line's illustration on the
 * line's tint, with the version that runs (Opus 5.5 shows 5.5). A model of no known line keeps
 * its provider's glyph, and CLI default or an alias the CLI has not resolved has no version. */
export type ModelMark = { line?: ModelLine; version?: string; glyph: string; color: string };

function mark(provider: ProviderId, line: ModelLine | undefined, version: string | undefined) {
  const color =
    line && !providerTinted.has(line) ? `var(--model-${line})` : providers[provider].color;
  return { line, version, glyph: providers[provider].mark, color };
}

export function modelMark(provider: ProviderId, name: string): ModelMark {
  if (provider === 'claude') {
    // Catalog and reported Claude names read Family or Family 5.5 (see formatModelName).
    const [, family, version] = /^([A-Z][a-z]+)(?: (\d{1,2}(?:\.\d{1,2})*))?$/.exec(name) ?? [];
    const line = family?.toLowerCase() as ModelLine | undefined;
    return mark(provider, line && claudeLines.has(line) ? line : undefined, version);
  }
  // GPT-5.6-Sol shows 5.6 and Gemini 3.8 Flash shows 3.8.
  const version = /\d+(?:\.\d+)?/.exec(name)?.[0];
  const known = version && version.length <= 4 ? version : undefined;
  const word = (pattern: string) => new RegExp(`(?:^|[^a-z])(${pattern})(?![a-z])`, 'i').exec(name);
  if (provider === 'codex') {
    const line = word('astra|sol|luna|terra')?.[1].toLowerCase() as ModelLine | undefined;
    return mark(provider, line ?? (/gpt/i.test(name) ? 'gpt' : undefined), known);
  }
  const line = word('flash|pro')?.[1].toLowerCase() as ModelLine | undefined;
  return mark(provider, line ?? (/gemini/i.test(name) ? 'gemini' : undefined), known);
}
