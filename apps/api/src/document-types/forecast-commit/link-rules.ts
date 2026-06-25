import type { LinkRule } from '@xbn/document-core';

/**
 * FORECAST_COMMIT → FORECAST_PUBLISH via RESPONDS_TO.
 * 'many in / one out': one commit answers exactly one published
 * forecast; a forecast can receive many commits over time (revised
 * commits).
 */
export const forecastCommitLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'FORECAST_COMMIT',
    toType: 'FORECAST_PUBLISH',
    linkType: 'RESPONDS_TO',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
];
