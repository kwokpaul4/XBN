import type { DocumentTypeModule } from '../registry.js';

import { GenericDocumentBody } from './body-schema.js';
import { genericDocumentLinkRules } from './link-rules.js';
import { genericDocumentMachine } from './state-machine.js';

export const genericDocumentModule: DocumentTypeModule = {
  documentType: 'GENERIC_DOCUMENT',
  bodySchema: GenericDocumentBody,
  stateMachine: genericDocumentMachine,
  outboundLinkRules: genericDocumentLinkRules,
};

export { GenericDocumentBody, genericDocumentMachine, genericDocumentLinkRules };
