import { z } from 'zod';

/**
 * CREDIT_MEMO body (PHASES.md §2.7).
 *
 * Supplier-issued credit against a previously-issued INVOICE. Reduces
 * what the buyer owes; XBN tracks it on the network but does not
 * compute net balances (buyer's ERP / AP system does).
 *
 * Body shape:
 *   - invoiceDocumentNumber/Id — the invoice being credited
 *   - reason (RETURN / PRICE_ADJUSTMENT / DAMAGED_GOODS / OTHER)
 *   - lines: per-line credit amounts
 *   - totals
 */

const Address = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().length(2),
});

const CreditMemoLine = z.object({
  /** References the invoice line being credited. */
  invoiceLineRef: z.string().min(1),
  sku: z.string().min(1),
  description: z.string().min(1),
  /** Quantity being credited (positive). */
  creditedQuantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  /** Resulting credit amount for this line. */
  creditAmount: z.number().nonnegative(),
});

export const CreditMemoBody = z.object({
  invoiceDocumentNumber: z.string().min(1),
  invoiceDocumentId: z.string().min(1),

  reason: z.enum(['RETURN', 'PRICE_ADJUSTMENT', 'DAMAGED_GOODS', 'OTHER']),
  reasonDetail: z.string().optional(),

  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3),
  remitTo: Address,

  lines: z.array(CreditMemoLine).min(1),
  /** Total credit amount (sum of line creditAmounts + any tax adjustments). */
  totalCreditAmount: z.number().positive(),

  notes: z.string().optional(),
});

export type CreditMemoBody = z.infer<typeof CreditMemoBody>;
