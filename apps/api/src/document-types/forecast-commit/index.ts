import type { DocumentTypeModule } from '../registry.js';

import { ForecastCommitBody } from './body-schema.js';
import { forecastCommitLinkRules } from './link-rules.js';
import { forecastCommitMachine } from './state-machine.js';

export const forecastCommitModule: DocumentTypeModule = {
  documentType: 'FORECAST_COMMIT',
  bodySchema: ForecastCommitBody,
  stateMachine: forecastCommitMachine,
  outboundLinkRules: forecastCommitLinkRules,
};

export { ForecastCommitBody, forecastCommitMachine, forecastCommitLinkRules };
