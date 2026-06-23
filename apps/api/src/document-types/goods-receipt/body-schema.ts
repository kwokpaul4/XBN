import { z } from 'zod';

/**
 * GOODS_RECEIPT body (PHASES.md §2.5).
 *
 * Buyer-side record of physical goods received against an ASN. Sources:
 *   - PO: lineRefs match the PO line refs being received against
 *   - ASN: the shipment delivered (RECEIVES link)
 *
 * Quantities here are what *actually arrived* — may be less than ASN
 * declared (short-shipment), more (over-shipment), or different. The
 * lineRef → receivedQuantity map is what Phase 2.6 INVOICE 3-way match
 * compares against.
 *
 * Body shape:
 *   - poDocumentNumber/Id and asnDocumentNumber/Id for round-trip safety
 *   - receivedAt date, optional received-by note
 *   - lines: receivedQuantity per lineRef, with optional rejection
 *     reasons / quality notes (the latter feeds Phase 3.5 quality
 *     notifications later)
 */

const GoodsReceiptLine = z.object({
  lineRef: z.string().min(1),
  sku: z.string().min(1),
  receivedQuantity: z.number().nonnegative(),
  unitOfMeasure: z.string().min(1),
  /** Quantity rejected (damaged / wrong item / etc.). Counts toward
   *  short-shipment for invoice match purposes. */
  rejectedQuantity: z.number().nonnegative().optional(),
  rejectionReason: z.string().optional(),
  notes: z.string().optional(),
});

export const GoodsReceiptBody = z.object({
  poDocumentNumber: z.string().min(1),
  poDocumentId: z.string().min(1),
  asnDocumentNumber: z.string().optional(),
  asnDocumentId: z.string().optional(),

  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receivedBy: z.string().optional(),

  lines: z.array(GoodsReceiptLine).min(1),
});

export type GoodsReceiptBody = z.infer<typeof GoodsReceiptBody>;
