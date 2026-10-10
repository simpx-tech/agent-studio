import { z } from 'zod';

// Providers validate their supported JSON Schema dialect, and their own limits. Local validation
// is deliberately limited to JSON syntax and an object root.
export function outputSchemaError(text: string): string | undefined {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object' || value.type !== 'object')
      return 'JSON Schema must describe an object ("type": "object").';
  } catch {
    return 'Enter valid JSON for the output schema.';
  }
}

export const outputSchemaSetting = z
  .string()
  .refine((text) => !outputSchemaError(text), 'Invalid structured output schema');
