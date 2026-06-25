import type { DocumentTypeModule } from '../registry.js';

import { SchedulingAgreementBody } from './body-schema.js';
import { schedulingAgreementLinkRules } from './link-rules.js';
import { schedulingAgreementMachine } from './state-machine.js';

export const schedulingAgreementModule: DocumentTypeModule = {
  documentType: 'SCHEDULING_AGREEMENT',
  bodySchema: SchedulingAgreementBody,
  stateMachine: schedulingAgreementMachine,
  outboundLinkRules: schedulingAgreementLinkRules,
};

export { SchedulingAgreementBody, schedulingAgreementMachine, schedulingAgreementLinkRules };
