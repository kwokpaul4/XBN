import { z } from 'zod';

/**
 * INVOICE body (PHASES.md §2.6).
 *
 * Discriminated union on `invoiceMode`:
 *
 *   PO_FLIP — single-PO invoice. INVOICES → exactly one PO (and
 *             optionally → GRs for 3-way match visibility). Portal
 *             pre-fills from the PO.
 *
 *   SUMMARY — consolidated/periodic invoice. INVOICES → MANY of any
 *             combination: POs, GRs, SA_RELEASE_JITs (Phase 3),
 *             CONSIGNMENT_CONSUMPTIONs (Phase 3.4),
 *             SUBCONTRACT_CONSUMPTION_REPORTs (Phase 3.3). Carries a
 *             billing period header.
 *
 * Match-status field is computed at the route layer (or async by a
 * worker for large invoices) — it's a *visibility aid* for the buyer's
 * AP team, NOT an approval gate. PHASES.md §2.6 cross-cutting concern:
 * XBN does not decide whether the invoice is paid.
 *
 * For SUMMARY invoices, the link-uniqueness DB constraint
 * (from_document_id, to_document_id, link_type) prevents an invoice
 * from referencing the same source document twice — this is the
 * no-double-billing guard.
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

/**
 * Invoice line — for PO_FLIP this mirrors a PO line; for SUMMARY each line
 * carries the source-document ref so the buyer's AP team can trace it.
 */
const InvoiceLine = z.object({
  /** Buyer's line ref from the original PO/GR/etc. */
  lineRef: z.string().min(1),
  sku: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  unitOfMeasure: z.string().min(1),
  /** For SUMMARY mode: which source document does this line refer to?
   *  PO id, GR id, JIT release id, etc. PO_FLIP omits since the entire
   *  invoice references one PO. */
  sourceDocumentId: z.string().optional(),
  sourceDocumentType: z.string().optional(),
});

const Tax = z.object({
  /** Tax type (e.g. 'VAT', 'GST', 'SALES_TAX') — free-form for MVP. */
  type: z.string().min(1),
  rate: z.number().nonnegative(),
  /** Computed amount; XBN doesn't recompute, just stores. */
  amount: z.number().nonnegative(),
});

export const InvoiceBody = z.discriminatedUnion('invoiceMode', [
  z.object({
    invoiceMode: z.literal('PO_FLIP'),
    /** Exactly one PO. */
    poDocumentNumber: z.string().min(1),
    poDocumentId: z.string().min(1),
    /** Optional list of GRs covered by this invoice (for 3-way match). */
    grDocumentIds: z.array(z.string()).optional(),

    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.string().length(3),
    paymentTermsRef: z.string().optional(),
    remitTo: Address,

    lines: z.array(InvoiceLine).min(1),
    taxes: z.array(Tax).optional(),
    subtotal: z.number().nonnegative(),
    taxTotal: z.number().nonnegative(),
    total: z.number().nonnegative(),

    notes: z.string().optional(),
  }),
  z.object({
    invoiceMode: z.literal('SUMMARY'),
    /** Multiple source documents covered by this consolidated invoice.
     *  At least one must be present. */
    sourceDocuments: z
      .array(
        z.object({
          documentType: z.string().min(1),
          documentId: z.string().min(1),
          documentNumber: z.string().optional(),
        }),
      )
      .min(1),

    /** Billing period header. */
    billingPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    billingPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.string().length(3),
    paymentTermsRef: z.string().optional(),
    remitTo: Address,

    lines: z.array(InvoiceLine).min(1),
    taxes: z.array(Tax).optional(),
    subtotal: z.number().nonnegative(),
    taxTotal: z.number().nonnegative(),
    total: z.number().nonnegative(),

    notes: z.string().optional(),
  }),
]);

export type InvoiceBody = z.infer<typeof InvoiceBody>;

/**
 * Match-status values surfaced on the invoice document row.
 * Computed at publish time and updated when linked GR/PO state changes.
 *
 * Visibility aid only — does NOT gate payment. Per PHASES.md §2.6:
 * 'XBN does not decide whether the invoice is paid.'
 */
export type MatchStatus =
  | 'MATCH_OK'
  | 'MATCH_QTY_MISMATCH'
  | 'MATCH_PRICE_MISMATCH'
  | 'NO_GR'
  | 'PENDING';
