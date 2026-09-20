import { z } from 'zod';

// CLI model aliases/IDs, including region-qualified IDs and the long-context suffix.
export const fallbackModelSetting = z
  .string()
  .max(302)
  .refine((value) => {
    const models = value.split(',');
    return (
      models.length <= 3 &&
      new Set(models).size === models.length &&
      models.every(
        (model) => model.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*(?:\[1m\])?$/.test(model),
      )
    );
  }, 'Enter up to three distinct model aliases or IDs, separated by commas.');

export function normalizeFallbackModel(value: string): string | undefined {
  return (
    value
      .split(',')
      .map((model) => model.trim())
      .join(',') || undefined
  );
}
