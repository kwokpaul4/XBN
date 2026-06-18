import type { DocumentTypeModule } from '../registry.js';

import { PoChangeBody } from './body-schema.js';
import { poChangeLinkRules } from './link-rules.js';
import { poChangeMachine } from './state-machine.js';

export const poChangeModule: DocumentTypeModule = {
  documentType: 'PO_CHANGE',
  bodySchema: PoChangeBody,
  stateMachine: poChangeMachine,
  outboundLinkRules: poChangeLinkRules,
};

export { PoChangeBody, poChangeMachine, poChangeLinkRules };
