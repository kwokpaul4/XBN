import type { LinkRule } from '@xbn/document-core';

/**
 * Invoice link rules (PHASES.md §2.6).
 *
 * INVOICES → PO: many-many. A PO can be invoiced by at most one
 * (invoice, linkType) triple per the DB unique — but conceptually
 * 'many in / many out' because:
 *   - SUMMARY invoice references many POs (outbound 'many')
 *   - A single PO is referenced by exactly one invoice over its lifetime
 *     in practice (DB unique on the triple prevents double-billing —
 *     the §2.6 guard).
 *
 * INVOICES → GOODS_RECEIPT: same shape; SUMMARY can reference many
 * GRs across the period.
 *
 * INVOICES → SA_RELEASE_JIT, CONSIGNMENT_CONSUMPTION,
 * SUBCONTRACT_CONSUMPTION_REPORT: registered for Phase 3 use; no harm
 * in declaring them now since the corresponding doc types will register
 * themselves later.
 */
export const invoiceLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'INVOICE',
    toType: 'PO',
    linkType: 'INVOICES',
    inboundCardinality: 'many',
    outboundCardinality: 'many',
  },
  {
    fromType: 'INVOICE',
    toType: 'GOODS_RECEIPT',
    linkType: 'INVOICES',
    inboundCardinality: 'many',
    outboundCardinality: 'many',
  },
];
