import type { LinkRule } from '@xbn/document-core';

/**
 * FORECAST_PUBLISH originates two link types:
 *   - CALLS_OFF → SCHEDULING_AGREEMENT (when the forecast hangs off an SA)
 *   - SUPERSEDES → FORECAST_PUBLISH (when revising a prior forecast)
 *
 * Both are optional at publish time; the supplier doesn't need either
 * to consume the forecast.
 */
export const forecastPublishLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'FORECAST_PUBLISH',
    toType: 'SCHEDULING_AGREEMENT',
    linkType: 'CALLS_OFF',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
  {
    fromType: 'FORECAST_PUBLISH',
    toType: 'FORECAST_PUBLISH',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
