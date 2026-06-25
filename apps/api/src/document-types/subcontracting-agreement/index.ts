import type { DocumentTypeModule } from '../registry.js';

import { SubcontractingAgreementBody } from './body-schema.js';
import { subcontractingAgreementLinkRules } from './link-rules.js';
import { subcontractingAgreementMachine } from './state-machine.js';

export const subcontractingAgreementModule: DocumentTypeModule = {
  documentType: 'SUBCONTRACTING_AGREEMENT',
  bodySchema: SubcontractingAgreementBody,
  stateMachine: subcontractingAgreementMachine,
  outboundLinkRules: subcontractingAgreementLinkRules,
};

export {
  SubcontractingAgreementBody,
  subcontractingAgreementMachine,
  subcontractingAgreementLinkRules,
};
