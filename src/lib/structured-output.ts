import { z } from 'zod';

export const maxOutputSchemaBytes = 16_000;

// Providers validate their supported JSON Schema dialect. Local validation is
// deliberately limited to JSON syntax, an object root, and bounded input.
export function outputSchemaError(text: string): string | undefined {
  if (new TextEncoder().encode(text).length > maxOutputSchemaBytes)
    return 'JSON Schema must be at most 16,000 bytes.';
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object' || value.type !== 'object')
      return 'JSON Schema must describe an object ("type": "object").';
    const bounded = (v: unknown, depth = 0): boolean =>
      depth <= 32 &&
      (!v || typeof v !== 'object' || Object.values(v).every((child) => bounded(child, depth + 1)));
    if (!bounded(value)) return 'JSON Schema is too deeply nested (maximum 32 levels).';
  } catch {
    return 'Enter valid JSON for the output schema.';
  }
}

export const outputSchemaSetting = z
  .string()
  .max(maxOutputSchemaBytes)
  .refine((text) => !outputSchemaError(text), 'Invalid structured output schema');
