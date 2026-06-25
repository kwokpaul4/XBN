import type { DocumentTypeModule } from '../registry.js';

import { ForecastPublishBody } from './body-schema.js';
import { forecastPublishLinkRules } from './link-rules.js';
import { forecastPublishMachine } from './state-machine.js';

export const forecastPublishModule: DocumentTypeModule = {
  documentType: 'FORECAST_PUBLISH',
  bodySchema: ForecastPublishBody,
  stateMachine: forecastPublishMachine,
  outboundLinkRules: forecastPublishLinkRules,
};

export { ForecastPublishBody, forecastPublishMachine, forecastPublishLinkRules };
