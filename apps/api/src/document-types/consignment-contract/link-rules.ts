import type { LinkRule } from '@xbn/document-core';

/** Anchor; targets only. Phase 3.4 CONSIGNMENT_FILL / CONSIGNMENT_CONSUMPTION
 *  will register their own → CONSIGNMENT_CONTRACT rules. */
export const consignmentContractLinkRules: ReadonlyArray<LinkRule> = [];
