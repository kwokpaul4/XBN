import type { LinkRule } from '@xbn/document-core';

/**
 * SA_RELEASE_FORECAST → SCHEDULING_AGREEMENT via CALLS_OFF.
 * SA_RELEASE_FORECAST → SA_RELEASE_FORECAST via SUPERSEDES (revisions).
 */
export const saReleaseForecastLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'SA_RELEASE_FORECAST',
    toType: 'SCHEDULING_AGREEMENT',
    linkType: 'CALLS_OFF',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
  {
    fromType: 'SA_RELEASE_FORECAST',
    toType: 'SA_RELEASE_FORECAST',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
