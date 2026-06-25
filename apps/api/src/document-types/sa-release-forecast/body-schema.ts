import { z } from 'zod';

/**
 * SA_RELEASE_FORECAST body (PHASES.md §3.2).
 *
 * Planning-grade release against a SCHEDULING_AGREEMENT. NOT firm — the
 * supplier uses it for capacity planning but doesn't ship against it.
 * The §3.2 SA_RELEASE_JIT is the firm call-off that produces ASNs.
 *
 * Each release carries a list of release lines, each with a delivery
 * date (or window) and quantity. Subsequent releases for the same
 * (sku, window) supersede prior ones — the latest is the truth.
 */

const ReleaseLine = z.object({
  /** Requested delivery date (firm date for JIT, advisory for FORECAST). */
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Release quantity for this delivery date. */
  quantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
});

export const SaReleaseForecastBody = z.object({
  schedulingAgreementDocumentNumber: z.string().min(1),
  schedulingAgreementDocumentId: z.string().min(1),

  itemSku: z.string().min(1),

  /** The horizon this release covers. Subsequent releases for the same
   *  window supersede. */
  windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  releaseLines: z.array(ReleaseLine).min(1),

  /** Optional reference to the prior release this supersedes. */
  supersedesReleaseDocumentId: z.string().optional(),

  notes: z.string().optional(),
});

export type SaReleaseForecastBody = z.infer<typeof SaReleaseForecastBody>;
