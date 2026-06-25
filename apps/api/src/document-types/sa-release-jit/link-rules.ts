import type { LinkRule } from '@xbn/document-core';

/**
 * SA_RELEASE_JIT → SCHEDULING_AGREEMENT via CALLS_OFF.
 * SA_RELEASE_JIT → SA_RELEASE_JIT via SUPERSEDES.
 *
 * Note: the reverse rule ASN → SA_RELEASE_JIT via SHIPS_AGAINST is the
 * polymorphic-predecessor test from PHASES.md §3.2 — the Phase 2 ASN
 * type was registered with `toType: 'PO'`; here we register the
 * additional rule allowing ASN to ship against a JIT release too. This
 * is the cross-phase test for the substrate.
 */
export const saReleaseJitLinkRules: ReadonlyArray<LinkRule> = [
  {
    fromType: 'SA_RELEASE_JIT',
    toType: 'SCHEDULING_AGREEMENT',
    linkType: 'CALLS_OFF',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
  {
    fromType: 'SA_RELEASE_JIT',
    toType: 'SA_RELEASE_JIT',
    linkType: 'SUPERSEDES',
    inboundCardinality: 'one',
    outboundCardinality: 'one',
  },
  /**
   * The polymorphic-predecessor rule: ASN → SA_RELEASE_JIT via
   * SHIPS_AGAINST. Registered here (with the JIT module) rather than
   * in the ASN module to keep type-pair rules co-located with the
   * downstream type whose existence enables the rule. Phase 2 ASN
   * already registers ASN → PO via SHIPS_AGAINST.
   */
  {
    fromType: 'ASN',
    toType: 'SA_RELEASE_JIT',
    linkType: 'SHIPS_AGAINST',
    inboundCardinality: 'many',
    outboundCardinality: 'one',
  },
];
