import type { DocumentTypeModule } from '../registry.js';

import { RemittanceAdviceBody } from './body-schema.js';
import { remittanceAdviceLinkRules } from './link-rules.js';
import { remittanceAdviceMachine } from './state-machine.js';

export const remittanceAdviceModule: DocumentTypeModule = {
  documentType: 'REMITTANCE_ADVICE',
  bodySchema: RemittanceAdviceBody,
  stateMachine: remittanceAdviceMachine,
  outboundLinkRules: remittanceAdviceLinkRules,
};

export { RemittanceAdviceBody, remittanceAdviceMachine, remittanceAdviceLinkRules };
