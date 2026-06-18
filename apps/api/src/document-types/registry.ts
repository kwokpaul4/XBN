/**
 * Document-type registry.
 *
 * Each document type ships a self-contained module that exports a
 * DocumentTypeModule object. The registry composes them into the
 * BodySchemaRegistry, LinkRegistry, and state-machine map that the
 * documents router consumes.
 *
 * This is the shape that EVERY Phase 2/3 document type will follow:
 *
 *   apps/api/src/document-types/<type>/
 *     body-schema.ts    Zod schema for the body
 *     state-machine.ts  Declarative {state → [{to, requiredRole, actor}]}
 *     link-rules.ts     LinkRule[] this type participates in
 *     index.ts          Re-exports as a DocumentTypeModule
 *
 * The point: once registered here, the document is publish/supersede/
 * transition/link/attach-able through the existing /documents routes
 * with no other changes.
 */

import {
  BodySchemaRegistry,
  LinkRegistry,
  type LinkRule,
  type StateMachine,
} from '@xbn/document-core';
import type { OrgRole } from '@xbn/db';
import type { ZodTypeAny } from 'zod';

import { genericDocumentModule } from './generic-document/index.js';
import { orderConfirmationModule } from './order-confirmation/index.js';
import { poChangeModule } from './po-change/index.js';
import { poModule } from './po/index.js';

export interface DocumentTypeModule {
  /** Document type identifier — must match the string used at publish time. */
  readonly documentType: string;
  /** Zod body schema. */
  readonly bodySchema: ZodTypeAny;
  /** Per-type state machine. */
  readonly stateMachine: StateMachine<string, OrgRole, unknown>;
  /** Link rules this type originates (fromType === this.documentType). */
  readonly outboundLinkRules: ReadonlyArray<LinkRule>;
}

const ALL_MODULES: ReadonlyArray<DocumentTypeModule> = [
  genericDocumentModule,
  poModule,
  orderConfirmationModule,
  poChangeModule,
];

export interface BuiltRegistry {
  readonly bodySchemas: BodySchemaRegistry;
  readonly linkRegistry: LinkRegistry;
  readonly stateMachines: Record<string, StateMachine<string, OrgRole, unknown>>;
}

export function buildDocumentTypeRegistry(): BuiltRegistry {
  const bodySchemas = new BodySchemaRegistry();
  const linkRegistry = new LinkRegistry();
  const stateMachines: Record<string, StateMachine<string, OrgRole, unknown>> = {};

  for (const m of ALL_MODULES) {
    bodySchemas.register(m.documentType, m.bodySchema);
    stateMachines[m.documentType] = m.stateMachine;
    for (const rule of m.outboundLinkRules) {
      linkRegistry.register(rule);
    }
  }

  return { bodySchemas, linkRegistry, stateMachines };
}

export function listRegisteredTypes(): ReadonlyArray<string> {
  return ALL_MODULES.map((m) => m.documentType);
}
