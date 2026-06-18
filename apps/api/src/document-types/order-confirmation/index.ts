import type { DocumentTypeModule } from '../registry.js';

import { OrderConfirmationBody } from './body-schema.js';
import { orderConfirmationLinkRules } from './link-rules.js';
import { orderConfirmationMachine } from './state-machine.js';

export const orderConfirmationModule: DocumentTypeModule = {
  documentType: 'ORDER_CONFIRMATION',
  bodySchema: OrderConfirmationBody,
  stateMachine: orderConfirmationMachine,
  outboundLinkRules: orderConfirmationLinkRules,
};

export { OrderConfirmationBody, orderConfirmationMachine, orderConfirmationLinkRules };
