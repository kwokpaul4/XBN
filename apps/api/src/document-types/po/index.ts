import type { DocumentTypeModule } from '../registry.js';

import { PoBody } from './body-schema.js';
import { poLinkRules } from './link-rules.js';
import { poMachine } from './state-machine.js';

export const poModule: DocumentTypeModule = {
  documentType: 'PO',
  bodySchema: PoBody,
  stateMachine: poMachine,
  outboundLinkRules: poLinkRules,
};

export { PoBody, poMachine, poLinkRules };
export type { Address, PoLine } from './body-schema.js';
