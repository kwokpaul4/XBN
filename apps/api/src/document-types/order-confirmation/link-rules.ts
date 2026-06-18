import type { LinkRule } from '@xbn/document-core';

/**
 * Link rules originating from an ORDER_CONFIRMATION.
 *
 * The single rule is ACKNOWLEDGES → PO. Cardinality "one in / one out"
 * means a PO has at most one acknowledgement and an acknowledgement
 * targets exactly one PO. (PO_CHANGE re-acknowledgement issues a NEW
 * ORDER_CONFIRMATION; the prior one stays linked to the original PO.)
 */
export const orderConfirmationLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'ORDER_CONFIRMATION',
    toType: 'PO',
    linkType: 'ACKNOWLEDGES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
