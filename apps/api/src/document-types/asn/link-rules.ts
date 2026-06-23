import type { LinkRule } from '@xbn/document-core';

/**
 * ASN → PO via SHIPS_AGAINST. inboundCardinality 'many' because a PO can
 * have multiple split shipments (multiple ASNs). outboundCardinality
 * 'one' — each ASN ships against exactly one PO.
 */
export const asnLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'ASN',
    toType: 'PO',
    linkType: 'SHIPS_AGAINST',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
];
