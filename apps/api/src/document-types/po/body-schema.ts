import { z } from 'zod';

/**
 * PO body schema (PHASES.md §2.1).
 *
 * Indirect-procurement Purchase Order. Anchored on a one-shot delivery
 * window; line items are SKU-based with quantity and unit price.
 *
 * Header carries:
 *   - currency (ISO-4217)
 *   - payment terms reference (free-form string, typically the buyer's
 *     payment-terms code on the trading relationship; copied here for
 *     immutability — the relationship's defaultCurrency may change)
 *   - Incoterms code (FOB, CIF, EXW, ...)
 *   - ship-to address (where the goods physically arrive)
 *   - bill-to address (where the invoice should be sent)
 *   - requested delivery date (ISO date string, YYYY-MM-DD)
 *   - optional buyer reference / cost-centre (free-form)
 *
 * Lines carry:
 *   - sku (the supplier's SKU; buyer's internal item ref goes in lineRef)
 *   - description
 *   - quantity (positive)
 *   - unitPrice (non-negative)
 *   - unitOfMeasure (EA, KG, M, ...)
 *   - lineRef (optional buyer-internal line reference)
 *
 * Phase 2 deliberately does NOT include tax breakdowns or discounts at
 * the line level — those land in Phase 2.6 with the invoice schema where
 * they actually belong (a PO is the buyer's request, not the financial
 * record). Adding them here would prematurely couple PO to AP concerns
 * that XBN explicitly leaves to the buyer's ERP.
 */

const Address = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(), // state / province
  postalCode: z.string().optional(),
  countryCode: z.string().length(2), // ISO-3166 alpha-2
});

const PoLine = z.object({
  sku: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  unitOfMeasure: z.string().min(1),
  lineRef: z.string().optional(),
});

export const PoBody = z.object({
  currency: z.string().length(3),
  paymentTermsRef: z.string().optional(),
  incoterms: z.string().optional(),
  buyerReference: z.string().optional(),
  costCentre: z.string().optional(),
  /** ISO YYYY-MM-DD. Suppliers may propose a different date in their ORDER_CONFIRMATION. */
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shipTo: Address,
  billTo: Address,
  lines: z.array(PoLine).min(1),
});

export type PoBody = z.infer<typeof PoBody>;
export type PoLine = z.infer<typeof PoLine>;
export type Address = z.infer<typeof Address>;
