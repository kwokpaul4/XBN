import type { DocumentTypeModule } from '../registry.js';

import { GoodsReceiptBody } from './body-schema.js';
import { goodsReceiptLinkRules } from './link-rules.js';
import { goodsReceiptMachine } from './state-machine.js';

export const goodsReceiptModule: DocumentTypeModule = {
  documentType: 'GOODS_RECEIPT',
  bodySchema: GoodsReceiptBody,
  stateMachine: goodsReceiptMachine,
  outboundLinkRules: goodsReceiptLinkRules,
};

export { GoodsReceiptBody, goodsReceiptMachine, goodsReceiptLinkRules };
