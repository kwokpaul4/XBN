import type { LinkRule } from '@xbn/document-core';

/**
 * Link rules this document type ORIGINATES (fromType === GENERIC_DOCUMENT).
 *
 * GENERIC_DOCUMENT can RESPONDS_TO another GENERIC_DOCUMENT — used for the
 * back-and-forth in the M1 vertical slice.
 */
export const genericDocumentLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'GENERIC_DOCUMENT',
    toType: 'GENERIC_DOCUMENT',
    linkType: 'RESPONDS_TO',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
];
