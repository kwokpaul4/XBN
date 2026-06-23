import type { LinkRule } from '@xbn/document-core';

/**
 * GR → ASN via RECEIVES (one-to-many: a GR receives goods from at most one
 * ASN, but an ASN can be received via multiple GRs over time if shipments
 * trickle in over days). GR → PO via FULFILLS — same partial-shipment
 * reasoning.
 */
export const goodsReceiptLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'GOODS_RECEIPT',
    toType: 'ASN',
    linkType: 'RECEIVES',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
  {
    fromType: 'GOODS_RECEIPT',
    toType: 'PO',
    linkType: 'FULFILLS',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
  /** Corrections supersede a prior GR. */
  {
    fromType: 'GOODS_RECEIPT',
    toType: 'GOODS_RECEIPT',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
