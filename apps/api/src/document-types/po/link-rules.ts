import type { LinkRule } from '@xbn/document-core';

/**
 * Link rules originating from a PO.
 *
 * A PO is generally the *target* of links (acknowledgements, ASNs,
 * goods receipts, invoices), not the source. The one outbound rule is
 * SUPERSEDES → another PO, used when a PO_CHANGE creates a new effective
 * PO that supersedes the original. (Task #8.)
 */
export const poLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'PO',
    toType: 'PO',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
