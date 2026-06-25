import { z } from 'zod';

/**
 * SUBCONTRACTING_AGREEMENT body (PHASES.md §3 anchor entities).
 *
 * Long-lived contract under which the buyer ships components to the
 * supplier for assembly into finished goods. The §3.3 SUBCONTRACT_*
 * documents hang off this contract. Phase 3.3 deferred; anchor body
 * exists for graph registration.
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

const Component = z.object({
  sku: z.string().min(1),
  description: z.string().min(1),
  unitOfMeasure: z.string().min(1),
  /** Components per finished-good unit (BOM ratio). */
  quantityPerFg: z.number().positive(),
});

export const SubcontractingAgreementBody = z.object({
  /** The finished-good sku the supplier assembles. */
  finishedGoodSku: z.string().min(1),
  finishedGoodDescription: z.string().min(1),
  finishedGoodUnitOfMeasure: z.string().min(1),
  /** What the supplier charges per finished-good unit (assembly fee). */
  assemblyFeePerUnit: z.number().nonnegative(),
  currency: z.string().length(3),
  validityStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validityEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Buyer's plant where finished goods ship to. */
  shipTo: Address,
  /** Component BOM — what the buyer ships in to make one finished-good unit. */
  components: z.array(Component).min(1),
  paymentTermsRef: z.string().optional(),
});

export type SubcontractingAgreementBody = z.infer<typeof SubcontractingAgreementBody>;
