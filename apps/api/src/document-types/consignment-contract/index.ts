import type { DocumentTypeModule } from '../registry.js';

import { ConsignmentContractBody } from './body-schema.js';
import { consignmentContractLinkRules } from './link-rules.js';
import { consignmentContractMachine } from './state-machine.js';

export const consignmentContractModule: DocumentTypeModule = {
  documentType: 'CONSIGNMENT_CONTRACT',
  bodySchema: ConsignmentContractBody,
  stateMachine: consignmentContractMachine,
  outboundLinkRules: consignmentContractLinkRules,
};

export { ConsignmentContractBody, consignmentContractMachine, consignmentContractLinkRules };
