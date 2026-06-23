import type { DocumentTypeModule } from '../registry.js';

import { InvoiceBody } from './body-schema.js';
import { invoiceLinkRules } from './link-rules.js';
import { invoiceMachine } from './state-machine.js';

export const invoiceModule: DocumentTypeModule = {
  documentType: 'INVOICE',
  bodySchema: InvoiceBody,
  stateMachine: invoiceMachine,
  outboundLinkRules: invoiceLinkRules,
};

export { InvoiceBody, invoiceMachine, invoiceLinkRules };
export type { MatchStatus } from './body-schema.js';
