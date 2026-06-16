/**
 * Link-type registry (PHASES.md §1.5, CLAUDE.md cross-cutting concern #1+#2).
 *
 * Documents form a DAG via DocumentLink rows. Not every link type is valid
 * between every pair of document types — `INVOICES` makes sense from
 * INVOICE → PO, but not from ASN → PO. This registry is the central source
 * of truth for which (fromType, toType, linkType) triples are allowed.
 *
 * Validity per Phase 2/3 is registered in apps/api at boot — this module
 * just provides the data structure and the lookup. Adding a new link type
 * for Phase 3 doesn't require changing this file; the registry is
 * append-only at runtime.
 *
 * Cardinality lives here too: a PO can have MANY ASNs (many `SHIPS_AGAINST`
 * inbound), but at most ONE current ORDER_CONFIRMATION (single
 * `ACKNOWLEDGES`). The registry captures this so callers can enforce it
 * before persisting.
 */

export type Cardinality = 'one' | 'many';

export interface LinkRule {
  /** Document type the link originates from (e.g. 'INVOICE'). */
  readonly fromType: string;
  /** Document type the link points at (e.g. 'PO'). */
  readonly toType: string;
  /** The link relation (e.g. 'INVOICES', 'FULFILLS'). */
  readonly linkType: string;
  /**
   * Per `toType` document, how many inbound links of this type are allowed?
   * 'one' = at most one INVOICE → PO_FLIP per PO.
   * 'many' = a PO may have many ASNs (SHIPS_AGAINST).
   */
  readonly inboundCardinality: Cardinality;
  /**
   * Per `fromType` document, how many outbound links of this type are allowed?
   * 'one' = each ORDER_CONFIRMATION acknowledges exactly one PO.
   * 'many' = an INVOICE in SUMMARY mode may INVOICES many POs.
   */
  readonly outboundCardinality: Cardinality;
}

export type LinkLookupResult =
  | { readonly ok: true; readonly rule: LinkRule }
  | { readonly ok: false; readonly reason: LinkRejection };

export type LinkRejection = {
  readonly kind: 'unknown_link';
  readonly fromType: string;
  readonly toType: string;
  readonly linkType: string;
};

export class LinkRegistry {
  private readonly rules = new Map<string, LinkRule>();

  /**
   * Register a rule. Calling twice with the same (fromType, toType, linkType)
   * triple is an error — registries should be loaded once at app boot.
   */
  register(rule: LinkRule): void {
    const key = LinkRegistry.key(rule.fromType, rule.toType, rule.linkType);
    if (this.rules.has(key)) {
      throw new Error(
        `LinkRegistry: duplicate rule for ${rule.fromType} -[${rule.linkType}]-> ${rule.toType}`,
      );
    }
    this.rules.set(key, rule);
  }

  /**
   * Look up a rule. Returns LinkLookupResult so callers can pattern-match
   * on rejections without throwing in hot paths.
   */
  lookup(fromType: string, toType: string, linkType: string): LinkLookupResult {
    const rule = this.rules.get(LinkRegistry.key(fromType, toType, linkType));
    if (!rule) {
      return { ok: false, reason: { kind: 'unknown_link', fromType, toType, linkType } };
    }
    return { ok: true, rule };
  }

  /**
   * All allowed link types from a given document type. Useful for UIs that
   * surface "what can I link this PO to?" affordances.
   */
  outboundFrom(fromType: string): ReadonlyArray<LinkRule> {
    const out: LinkRule[] = [];
    for (const rule of this.rules.values()) {
      if (rule.fromType === fromType) out.push(rule);
    }
    return out;
  }

  /**
   * All allowed link types into a given document type.
   */
  inboundTo(toType: string): ReadonlyArray<LinkRule> {
    const out: LinkRule[] = [];
    for (const rule of this.rules.values()) {
      if (rule.toType === toType) out.push(rule);
    }
    return out;
  }

  size(): number {
    return this.rules.size;
  }

  private static key(fromType: string, toType: string, linkType: string): string {
    return `${fromType}|${linkType}|${toType}`;
  }
}
