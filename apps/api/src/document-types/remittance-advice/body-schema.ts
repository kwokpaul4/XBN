import { z } from 'zod';

/**
 * REMITTANCE_ADVICE body (PHASES.md §2.8).
 *
 * Buyer→supplier notification: 'we paid X against these invoices on this
 * date by this method'. Critical scope guard from PHASES.md §2.8:
 *
 *   XBN does NOT move money. Remittance advice is a notification
 *   document that lets the supplier reconcile their AR against actual
 *   payments made by the buyer's ERP/AP system.
 *
 * Body shape:
 *   - paymentDate, paymentMethod, paymentReference (the wire / ACH /
 *     check id from the buyer's bank — buyer captures it from their
 *     payment system)
 *   - allocations: how the payment was applied across invoices /
 *     credit memos. Each allocation references a source document
 *     (INVOICE or CREDIT_MEMO) by id and number, plus the amount paid
 *     (or credited) against it.
 *   - totals
 */

const Allocation = z.object({
  documentType: z.enum(['INVOICE', 'CREDIT_MEMO']),
  documentId: z.string().min(1),
  documentNumber: z.string().min(1),
  /** Positive for invoices (payment), positive for credit memos (credit
   *  applied against the supplier's balance — same sign because we're
   *  describing what was applied, not arithmetic). */
  appliedAmount: z.number().nonnegative(),
});

export const RemittanceAdviceBody = z.object({
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(['WIRE', 'ACH', 'CHECK', 'OTHER']),
  paymentMethodDetail: z.string().optional(),
  /** External reference from the buyer's bank/AP system — wire id, check
   *  number, ACH trace id. Free-form. */
  paymentReference: z.string().min(1),

  currency: z.string().length(3),
  totalPaymentAmount: z.number().nonnegative(),

  allocations: z.array(Allocation).min(1),

  notes: z.string().optional(),
});

export type RemittanceAdviceBody = z.infer<typeof RemittanceAdviceBody>;
