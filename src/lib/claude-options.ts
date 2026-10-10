import { z } from 'zod';

// CLI model aliases/IDs, including region-qualified IDs and the long-context suffix.
// The CLI reports its own limit on how many it takes.
export const fallbackModelSetting = z.string().refine((value) => {
  const models = value.split(',');
  return (
    new Set(models).size === models.length &&
    models.every((model) => /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*(?:\[1m\])?$/.test(model))
  );
}, 'Enter distinct model aliases or IDs, separated by commas.');

export function normalizeFallbackModel(value: string): string | undefined {
  return (
    value
      .split(',')
      .map((model) => model.trim())
      .join(',') || undefined
  );
}
