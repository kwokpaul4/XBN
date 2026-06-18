import { z } from 'zod';

/**
 * ORDER_CONFIRMATION body (PHASES.md §2.3).
 *
 * The supplier's response to a PO. Three response modes:
 *
 *   FULL_ACCEPT          — supplier accepts the PO as issued. No proposed
 *                          changes; the buyer's PO advances on its own
 *                          state machine via the buyer's transition.
 *
 *   ACCEPT_WITH_CHANGES  — supplier accepts in principle but proposes
 *                          amended line items (e.g. partial quantity, a
 *                          later delivery date, a price change) and/or
 *                          a revised requestedDeliveryDate at the header.
 *                          The buyer reviews and either:
 *                            - ACCEPTED_BY_BUYER  → buyer must issue a
 *                              PO_CHANGE to materialise the agreed
 *                              amendments (the OC by itself doesn't
 *                              modify the PO body — only PO versions
 *                              modify the PO body).
 *                            - REJECTED_BY_BUYER  → buyer rejects the
 *                              counter-proposal; supplier may issue a
 *                              new OC, or the buyer may cancel the PO.
 *
 *   REJECT               — supplier declines the PO. Terminal at this
 *                          layer; buyer's PO can be CANCELLED or kept
 *                          for re-routing to another supplier.
 *
 * Body validation uses a Zod discriminated union on `mode`:
 *   - FULL_ACCEPT and REJECT carry only the PO reference and an
 *     optional comment.
 *   - ACCEPT_WITH_CHANGES requires a `proposedChanges` block with at
 *     least one of {revisedRequestedDeliveryDate, revisedLines}.
 *
 * The proposed changes are *advisory* — they don't mutate the PO. The
 * buyer issues a PO_CHANGE to materialise them. This keeps the
 * authoritative PO body single-sourced (only PO versions = PO body).
 */

const ProposedLineRevision = z.object({
  /** Buyer-side line ref (or sku, when no lineRef was set on the PO). */
  lineRef: z.string().min(1),
  revisedQuantity: z.number().positive().optional(),
  revisedUnitPrice: z.number().nonnegative().optional(),
  /** ISO YYYY-MM-DD; supplier proposes a different delivery for this line. */
  revisedDeliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  comments: z.string().optional(),
});

const ProposedChanges = z.object({
  /** Header-level proposed delivery date (applies if no per-line revision). */
  revisedRequestedDeliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Per-line revisions. */
  revisedLines: z.array(ProposedLineRevision).optional(),
});

export const OrderConfirmationBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('FULL_ACCEPT'),
    poDocumentNumber: z.string().min(1),
    /** PO id captured for round-trip safety; the ACKNOWLEDGES link is
     *  the system-of-record. */
    poDocumentId: z.string().min(1),
    comments: z.string().optional(),
  }),
  z.object({
    mode: z.literal('ACCEPT_WITH_CHANGES'),
    poDocumentNumber: z.string().min(1),
    poDocumentId: z.string().min(1),
    comments: z.string().optional(),
    proposedChanges: ProposedChanges.refine(
      (c) =>
        c.revisedRequestedDeliveryDate !== undefined ||
        (c.revisedLines !== undefined && c.revisedLines.length > 0),
      {
        message:
          'ACCEPT_WITH_CHANGES requires at least one of revisedRequestedDeliveryDate or revisedLines',
      },
    ),
  }),
  z.object({
    mode: z.literal('REJECT'),
    poDocumentNumber: z.string().min(1),
    poDocumentId: z.string().min(1),
    comments: z.string().optional(),
  }),
]);

export type OrderConfirmationBody = z.infer<typeof OrderConfirmationBody>;
