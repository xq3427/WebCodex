import { z } from 'zod';

/** One public error contract for standard tools and component-only tools. */
export const toolErrorSchema = z.object({
  code: z.string(), message: z.string(), details: z.unknown().optional(),
  retryable: z.boolean().optional(),
  reason: z.enum(['parent_not_found', 'target_not_found']).optional(),
  recovery: z.object({ action: z.string(), instruction: z.string(), tools: z.array(z.string()) }).optional(),
});
