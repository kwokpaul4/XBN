import type { DocumentTypeModule } from '../registry.js';

import { SaReleaseForecastBody } from './body-schema.js';
import { saReleaseForecastLinkRules } from './link-rules.js';
import { saReleaseForecastMachine } from './state-machine.js';

export const saReleaseForecastModule: DocumentTypeModule = {
  documentType: 'SA_RELEASE_FORECAST',
  bodySchema: SaReleaseForecastBody,
  stateMachine: saReleaseForecastMachine,
  outboundLinkRules: saReleaseForecastLinkRules,
};

export { SaReleaseForecastBody, saReleaseForecastMachine, saReleaseForecastLinkRules };
