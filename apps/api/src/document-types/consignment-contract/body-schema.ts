import { z } from 'zod';

/**
 * CONSIGNMENT_CONTRACT body (PHASES.md §3 anchor entities, deferred body
 * for §3.4 movements).
 *
 * Long-lived contract under which supplier-owned stock sits at the
 * buyer's location and is consumed over time (supplier still owns it
 * until the buyer consumes it). The §3.4 CONSIGNMENT_FILL and
 * CONSIGNMENT_CONSUMPTION documents hang off this contract.
 *
 * Phase 3.4 itself is deferred per the original plan; this anchor body
 * exists so the broader SCC document graph (FORECAST etc.) has a place
 * to register against. The state machine and link rules are minimal.
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

export const ConsignmentContractBody = z.object({
  itemSku: z.string().min(1),
  itemDescription: z.string().min(1),
  unitOfMeasure: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  currency: z.string().length(3),
  validityStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validityEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The buyer location where the consignment stock physically sits. */
  stockLocation: Address,
  /** Replenishment trigger (reorder point) — optional advisory level. */
  reorderPoint: z.number().nonnegative().optional(),
  settlementCadence: z.enum(['WEEKLY', 'MONTHLY', 'PER_CONSUMPTION']).optional(),
  paymentTermsRef: z.string().optional(),
});

export type ConsignmentContractBody = z.infer<typeof ConsignmentContractBody>;
