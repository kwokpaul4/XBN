import { z } from 'zod';

/**
 * GENERIC_DOCUMENT body — free-form metadata + a note.
 * The "drop a PDF here" escape hatch from PHASES.md §1.6.
 */
export const GenericDocumentBody = z.object({
  note: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type GenericDocumentBody = z.infer<typeof GenericDocumentBody>;
