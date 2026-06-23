import type { LinkRule } from '@xbn/document-core';

/**
 * REMITS → INVOICE / CREDIT_MEMO. A remittance advice can describe
 * payments / credits applied to many source documents (it's the
 * standard 'consolidated payment' shape). And conversely a single
 * invoice may be paid across multiple remittance advices over time
 * (partial payments).
 */
export const remittanceAdviceLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'REMITTANCE_ADVICE',
    toType: 'INVOICE',
    linkType: 'REMITS',
    inboundCardinality: 'many',
    outboundCardinality: 'many',
  },
  {
    fromType: 'REMITTANCE_ADVICE',
    toType: 'CREDIT_MEMO',
    linkType: 'REMITS',
    inboundCardinality: 'many',
    outboundCardinality: 'many',
  },
];
