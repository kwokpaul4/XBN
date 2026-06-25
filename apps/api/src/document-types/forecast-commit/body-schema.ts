import { z } from 'zod';

/**
 * FORECAST_COMMIT body (PHASES.md §3.1).
 *
 * Supplier's response to a FORECAST_PUBLISH. For each bucket the
 * supplier issues one of:
 *   - COMMIT — yes, can supply that quantity
 *   - COMMIT_WITH_DEVIATION — partial commit; supplier states the qty
 *     they can actually supply
 *   - CANNOT_COMMIT — no capacity
 *
 * The buyer reads this back into their MRP/planning. XBN doesn't
 * compute deltas — that's an ERP concern. We just transport the
 * commit and surface it in the audit DAG.
 */

const ForecastCommitBucket = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('COMMIT'),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    committedQuantity: z.number().positive(),
  }),
  z.object({
    mode: z.literal('COMMIT_WITH_DEVIATION'),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Quantity supplier can actually supply (typically lower than
     *  forecasted; may be higher). */
    committedQuantity: z.number().nonnegative(),
    /** Optional supplier note explaining the deviation. */
    deviationReason: z.string().optional(),
  }),
  z.object({
    mode: z.literal('CANNOT_COMMIT'),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().optional(),
  }),
]);

export const ForecastCommitBody = z.object({
  /** The forecast this responds to. RESPONDS_TO link auto-created. */
  forecastDocumentNumber: z.string().min(1),
  forecastDocumentId: z.string().min(1),

  itemSku: z.string().min(1),
  unitOfMeasure: z.string().min(1),

  /** Per-bucket commit decisions. Should cover the same windows as the
   *  forecast, but the schema is lenient — supplier may commit on a subset. */
  buckets: z.array(ForecastCommitBucket).min(1),

  notes: z.string().optional(),
});

export type ForecastCommitBody = z.infer<typeof ForecastCommitBody>;
