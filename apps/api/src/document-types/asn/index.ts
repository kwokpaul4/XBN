import type { DocumentTypeModule } from '../registry.js';

import { AsnBody } from './body-schema.js';
import { asnLinkRules } from './link-rules.js';
import { asnMachine } from './state-machine.js';

export const asnModule: DocumentTypeModule = {
  documentType: 'ASN',
  bodySchema: AsnBody,
  stateMachine: asnMachine,
  outboundLinkRules: asnLinkRules,
};

export { AsnBody, asnMachine, asnLinkRules };
