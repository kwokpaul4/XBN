import { z } from 'zod';

/**
 * PO_CHANGE body (PHASES.md §2.2).
 *
 * A PO_CHANGE is a buyer-issued amendment to an existing PO. Rather than a
 * delta-diff document (which is fragile when the supplier hasn't seen
 * intermediate edits), it carries the COMPLETE REVISED PO BODY plus a
 * change reason and a list of which line refs were touched. The audit log
 * and the supplier UI compute the diff against the prior PO version.
 *
 * This matches Ariba's "PO Change" model and avoids the
 * "patch-against-stale-state" pitfalls of delta-style change documents.
 *
 * Reuses the same Address and PoLine shapes as the PO itself for
 * round-trip safety — a buyer can't accidentally introduce a field on
 * change that the PO schema doesn't permit.
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

const PoLine = z.object({
  sku: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  unitOfMeasure: z.string().min(1),
  lineRef: z.string().optional(),
});

export const PoChangeBody = z.object({
  /**
   * The PO being amended — captured as documentNumber AND id (number for
   * humans, id for machine reference). The SUPERSEDES link in
   * document_links is the system-of-record.
   */
  poDocumentNumber: z.string().min(1),
  poDocumentId: z.string().min(1),

  /** Human-facing reason. Surfaced in audit + supplier view. */
  changeReason: z.string().min(1),

  /** Line refs the change touched. Optional convenience for the supplier
   *  UI to highlight diffs without a full body comparison. */
  affectedLineRefs: z.array(z.string()).optional(),

  /** The complete revised PO body. */
  revisedBody: z.object({
    currency: z.string().length(3),
    paymentTermsRef: z.string().optional(),
    incoterms: z.string().optional(),
    buyerReference: z.string().optional(),
    costCentre: z.string().optional(),
    requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shipTo: Address,
    billTo: Address,
    lines: z.array(PoLine).min(1),
  }),
});

export type PoChangeBody = z.infer<typeof PoChangeBody>;
