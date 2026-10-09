import { z } from 'zod';

/**
 * JSON Schema for a Zod schema, e.g. the Analyst's structured output format.
 * Refinements (`.refine`, `.superRefine`) are not representable and are dropped,
 * so always re-validate responses with the Zod schema itself.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' });
}
