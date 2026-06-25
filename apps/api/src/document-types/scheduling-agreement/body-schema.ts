import { z } from 'zod';

/**
 * SCHEDULING_AGREEMENT body (PHASES.md §3 anchor entities).
 *
 * Long-lived contract (lifetime measured in years) anchoring:
 *   - FORECAST_PUBLISH / FORECAST_COMMIT (§3.1)
 *   - SA_RELEASE_FORECAST / SA_RELEASE_JIT (§3.2)
 *   - ASNs (via polymorphic predecessor — Phase 2 ASN type SHIPS_AGAINST
 *     either a PO or an SA release)
 *
 * Single item (sku) per SA in this MVP — Ariba SCC permits multi-item SAs
 * but the value of multi-item shapes in the network MVP is limited; each
 * additional sku usually gets its own SA in practice. We can lift this if
 * a customer requires it without breaking existing SAs.
 *
 * Body shape:
 *   - itemSku / itemDescription — what's being agreed to
 *   - validityStart / validityEnd — when the SA is active
 *   - targetQuantity — total qty agreed across the validity window
 *   - unitOfMeasure
 *   - unitPrice (may be revised by amendment — out of MVP scope)
 *   - plant / shipTo — destination plant
 *   - paymentTermsRef / incoterms — same shape as PO
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

export const SchedulingAgreementBody = z.object({
  itemSku: z.string().min(1),
  itemDescription: z.string().min(1),
  targetQuantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  currency: z.string().length(3),
  validityStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validityEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plant: z.string().min(1),
  shipTo: Address,
  paymentTermsRef: z.string().optional(),
  incoterms: z.string().optional(),
  buyerReference: z.string().optional(),
});

export type SchedulingAgreementBody = z.infer<typeof SchedulingAgreementBody>;
