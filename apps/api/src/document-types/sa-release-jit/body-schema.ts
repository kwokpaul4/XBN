import { z } from 'zod';

/**
 * SA_RELEASE_JIT body (PHASES.md §3.2).
 *
 * Firm call-off — the supplier is expected to ship against this within
 * the stated delivery window. ASNs SHIPS_AGAINST a JIT release (the
 * polymorphic-predecessor test from PHASES.md §3.2: the Phase 2 ASN
 * type works against both PO and SA_RELEASE_JIT).
 *
 * Same body shape as SA_RELEASE_FORECAST but distinguished by document
 * type — the supplier's portal/workflows treat firm vs planning
 * differently. The link cardinality also differs (one ASN can ship
 * against many JIT releases conceptually, but inboundCardinality 'one'
 * keeps it strict for MVP).
 */

const ReleaseLine = z.object({
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
  /** Optional time-of-day for true JIT (e.g. '08:00' for the dock slot). */
  requestedDeliveryTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
});

export const SaReleaseJitBody = z.object({
  schedulingAgreementDocumentNumber: z.string().min(1),
  schedulingAgreementDocumentId: z.string().min(1),

  itemSku: z.string().min(1),

  /** JIT call-offs typically have shorter, firmer windows than forecast releases. */
  windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  releaseLines: z.array(ReleaseLine).min(1),

  supersedesReleaseDocumentId: z.string().optional(),

  notes: z.string().optional(),
});

export type SaReleaseJitBody = z.infer<typeof SaReleaseJitBody>;
