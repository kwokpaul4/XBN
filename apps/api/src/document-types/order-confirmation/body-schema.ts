import { z } from 'zod';

/**
 * ORDER_CONFIRMATION body (POAck).
 *
 * Phase 1.6 minimum — extended significantly in Task #9 with proposed
 * lines/dates for ACCEPT_WITH_CHANGES.
 */
export const OrderConfirmationBody = z.object({
  poDocumentNumber: z.string(),
  mode: z.enum(['FULL_ACCEPT', 'ACCEPT_WITH_CHANGES', 'REJECT']),
  comments: z.string().optional(),
});

export type OrderConfirmationBody = z.infer<typeof OrderConfirmationBody>;
