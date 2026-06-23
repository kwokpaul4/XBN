import { z } from 'zod';

/**
 * ASN body (PHASES.md §2.4).
 *
 * Advance Ship Notice — supplier→buyer notification that goods are
 * shipping. SHIPS_AGAINST a PO; the buyer receives goods against this
 * ASN to close the PO line quantities (Task #11 GR consumes this).
 *
 * One PO can have many ASNs (split shipments) — handled via
 * inboundCardinality 'many' on the SHIPS_AGAINST link rule.
 *
 * Body shape:
 *   - shipment header: carrier, tracking number, expected delivery,
 *     ship-from address
 *   - lines: each line references a PO line by lineRef (or sku) and
 *     declares the shipped quantity (≤ PO line quantity in practice;
 *     we don't enforce that at the schema layer because partial
 *     shipments + remainders need flexibility)
 *   - optional packing structure (handling units, serial / lot ids)
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

const AsnLine = z.object({
  /** Matches the lineRef on the corresponding PO line (or the sku). */
  lineRef: z.string().min(1),
  sku: z.string().min(1),
  shippedQuantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
  /** Optional lot or serial-number capture for direct-materials use cases. */
  lotNumber: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const HandlingUnit = z.object({
  type: z.string().min(1), // 'PALLET', 'CARTON', etc.
  trackingId: z.string().optional(),
  /** sku list contained in this HU, indexed into ASN lines by lineRef. */
  lineRefs: z.array(z.string()).min(1),
});

export const AsnBody = z.object({
  /** PO this shipment fulfils, captured for round-trip safety. */
  poDocumentNumber: z.string().min(1),
  poDocumentId: z.string().min(1),

  carrier: z.string().min(1),
  trackingNumber: z.string().optional(),
  shippedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shipFrom: Address,
  comments: z.string().optional(),

  lines: z.array(AsnLine).min(1),
  handlingUnits: z.array(HandlingUnit).optional(),
});

export type AsnBody = z.infer<typeof AsnBody>;
