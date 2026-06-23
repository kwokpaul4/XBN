import type { LinkRule } from '@xbn/document-core';

/**
 * CREDIT_MEMO → INVOICE via CREDITS. inboundCardinality 'many' because
 * a single invoice can be credited by multiple credit memos over time
 * (separate returns / adjustments).
 */
export const creditMemoLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'CREDIT_MEMO',
    toType: 'INVOICE',
    linkType: 'CREDITS',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
];
