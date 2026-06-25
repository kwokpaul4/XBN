import type { DocumentTypeModule } from '../registry.js';

import { SaReleaseJitBody } from './body-schema.js';
import { saReleaseJitLinkRules } from './link-rules.js';
import { saReleaseJitMachine } from './state-machine.js';

export const saReleaseJitModule: DocumentTypeModule = {
  documentType: 'SA_RELEASE_JIT',
  bodySchema: SaReleaseJitBody,
  stateMachine: saReleaseJitMachine,
  outboundLinkRules: saReleaseJitLinkRules,
};

export { SaReleaseJitBody, saReleaseJitMachine, saReleaseJitLinkRules };
