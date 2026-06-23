import type { DocumentTypeModule } from '../registry.js';

import { CreditMemoBody } from './body-schema.js';
import { creditMemoLinkRules } from './link-rules.js';
import { creditMemoMachine } from './state-machine.js';

export const creditMemoModule: DocumentTypeModule = {
  documentType: 'CREDIT_MEMO',
  bodySchema: CreditMemoBody,
  stateMachine: creditMemoMachine,
  outboundLinkRules: creditMemoLinkRules,
};

export { CreditMemoBody, creditMemoMachine, creditMemoLinkRules };
