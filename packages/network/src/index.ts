/**
 * @xbn/network — trading-partner network services (PHASES.md §1.3).
 *
 * Pure service layer over the Prisma schema. The NestJS API in apps/api
 * adapts these into HTTP routes; the document-core's TradingRelationshipGuard
 * already enforces the access rules at the substrate layer.
 *
 * Phase 1.3 surface:
 *   - Org create / list / get
 *   - OrgIdentifier add / remove (DUNS, GLN, tax IDs, buyer-internal IDs)
 *   - TradingRelationship lifecycle: invite → accept → activate →
 *     suspend → terminate
 *   - RelationshipInvitation issue + accept + decline + expire
 *   - Per-relationship config: enabled document types, payment terms,
 *     currency, Incoterms, summaryInvoicingEnabled, document_number_source
 */

export * from './orgs.js';
export * from './org-identifiers.js';
export * from './invitations.js';
export * from './relationships.js';
