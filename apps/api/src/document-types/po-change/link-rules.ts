import type { LinkRule } from '@xbn/document-core';

/**
 * Link rules originating from a PO_CHANGE.
 *
 * SUPERSEDES → PO. Inbound 'one' means a PO is targeted by at most one
 * SUPERSEDES at a time at the registry level — the DB unique on
 * (fromDocumentId, toDocumentId, linkType) further pins the per-pair
 * uniqueness. Outbound 'one' means a single PO_CHANGE supersedes exactly
 * one PO.
 *
 * Note: cardinality 'one' inbound is a *registry* hint, not a hard
 * constraint over the PO's lifetime. A PO can have multiple historical
 * PO_CHANGE documents pointing at it across time (each its own row); the
 * uniqueness is per (from, to, linkType) triple. The buyer issuing a
 * second PO_CHANGE on the same PO publishes a NEW PO_CHANGE document
 * with a NEW id, so the (from, to) pair differs. The CHANGED-guard logic
 * in document-core looks for the *latest accepted* PO_CHANGE among any.
 */
export const poChangeLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'PO_CHANGE',
    toType: 'PO',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
];
