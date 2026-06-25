import { z } from 'zod';

/**
 * FORECAST_PUBLISH body (PHASES.md §3.1).
 *
 * Buyer's bucketed demand signal against either a SCHEDULING_AGREEMENT
 * or an item-supplier pair (when no SA exists yet). Time-bucketed —
 * typically weekly across a 26-week horizon, but the schema accepts any
 * bucket cadence as long as start/end dates are ISO YYYY-MM-DD.
 *
 * Each publish is IMMUTABLE. To revise a forecast, the buyer publishes
 * a new FORECAST_PUBLISH and SUPERSEDES → the prior forecast for the
 * same (sku, window). The substrate's append-only versioning + the
 * SUPERSEDES link form the audit trail.
 */

const ForecastBucket = z.object({
  /** Bucket window — typically a calendar week. */
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Forecast quantity for this bucket. Zero is valid (explicit no-demand). */
  forecastQuantity: z.number().nonnegative(),
});

export const ForecastPublishBody = z.object({
  /** SA this forecast hangs off (when one exists). Optional — forecasts
   *  can also exist for sku-supplier pairs without a formal SA. */
  schedulingAgreementDocumentNumber: z.string().optional(),
  schedulingAgreementDocumentId: z.string().optional(),

  itemSku: z.string().min(1),
  itemDescription: z.string().min(1),
  unitOfMeasure: z.string().min(1),

  /** The full horizon window covered by this publish. The buckets[] must
   *  fall within this window. */
  horizonStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horizonEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  buckets: z.array(ForecastBucket).min(1),

  /** Optional reference to the prior forecast this supersedes. The
   *  SUPERSEDES link is auto-created by the route on publish. */
  supersedesForecastDocumentId: z.string().optional(),

  notes: z.string().optional(),
});

export type ForecastPublishBody = z.infer<typeof ForecastPublishBody>;
